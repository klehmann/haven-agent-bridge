/**
 * stdio entry point for MCP clients that start a command (Goose, Claude Code,
 * Claude Desktop, Cursor …). It forwards JSON-RPC 1:1 to the daemon's
 * Streamable HTTP endpoint and starts the daemon when none is running, so
 * several clients share one connection to the browser.
 *
 * If the daemon goes away (restart, update), the shim starts a new one,
 * replays the client's `initialize` and tells the client to re-read its
 * tools, so the client never notices beyond a changed tool list.
 */
import { spawn } from "node:child_process";
import { existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { ensureHome, readPrivate } from "./config.js";
import { BRIDGE_NAME } from "./protocol.js";

const CLI_PATH = join(fileURLToPath(new URL(".", import.meta.url)), "cli.js");
const START_TIMEOUT_MS = 8_000;

export type DaemonAddress = { port: number; token: string; instance?: string };

/** The running daemon's address, or `null`. */
export async function findDaemon(): Promise<DaemonAddress | null> {
  const port = Number(readPrivate("port"));
  if (!port) return null;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/.well-known/${BRIDGE_NAME}`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const info = (await res.json()) as { name?: string; token?: string; instance?: string };
    return info.name === BRIDGE_NAME && info.token ? { port, token: info.token, instance: info.instance } : null;
  } catch {
    return null;
  }
}

/** Finds the daemon or starts one in the background (it exits when idle). */
export async function ensureDaemon(): Promise<DaemonAddress> {
  const running = await findDaemon();
  if (running) return running;
  const home = ensureHome();
  const out = openSync(join(home, "daemon.log"), "a", 0o600);
  const child = spawn(process.execPath, [CLI_PATH, "daemon", "--auto-exit"], {
    detached: true,
    stdio: ["ignore", out, out],
    env: process.env,
  });
  child.unref();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(150);
    const started = await findDaemon();
    if (started) return started;
  }
  throw new Error(`The bridge daemon did not start; see ${join(home, "daemon.log")}`);
}

/**
 * Makes sure only one daemon runs. Returns a release function, or `null` when
 * another live daemon holds the lock.
 */
export function acquireDaemonLock(): (() => void) | null {
  const lock = join(ensureHome(), "daemon.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      const release = () => {
        try {
          if (readFileSync(lock, "utf8").trim() === String(process.pid)) unlinkSync(lock);
        } catch {
          // Already gone.
        }
      };
      return release;
    } catch {
      const pid = Number(existsSync(lock) ? readFileSync(lock, "utf8").trim() : 0);
      if (pid && isAlive(pid)) return null;
      try {
        unlinkSync(lock); // stale lock from a crashed daemon
      } catch {
        // Raced with another process; try again.
      }
    }
  }
  return null;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function runShim(): Promise<void> {
  const stdio = new StdioServerTransport();
  let address = await ensureDaemon();
  let http: StreamableHTTPClientTransport | null = null;
  let initialize: (JSONRPCMessage & { id: string | number; method: string }) | null = null;
  let initialized = false;
  let reconnecting: Promise<void> | null = null;
  let replay: { id: string; done: () => void } | null = null;
  /** Requests sent to the daemon whose answer has not come back yet. */
  const pending = new Map<string | number, string>();

  const warn = (text: string) => process.stderr.write(`[haven-agent-bridge] ${text}\n`);

  const connect = async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${address.token}` } },
    });
    transport.onmessage = (message) => {
      const m = message as { id?: string | number; result?: { protocolVersion?: string } };
      if (initialize && m.id !== undefined && m.id === initialize.id && m.result?.protocolVersion) {
        transport.setProtocolVersion(m.result.protocolVersion);
      }
      if (replay && m.id === replay.id) {
        if (m.result?.protocolVersion) transport.setProtocolVersion(m.result.protocolVersion);
        replay.done();
        return; // the client already has its initialize answer
      }
      if (m.id !== undefined && !("method" in (message as object))) pending.delete(m.id);
      void stdio.send(message);
    };
    transport.onerror = (error) => {
      warn(`daemon connection: ${error.message}`);
      void checkDaemon();
    };
    await transport.start();
    http = transport;
  };

  /**
   * Answers every request still waiting on a daemon that is gone or was
   * restarted: its answer will never come. A tool call may have run before the
   * connection broke, so it is reported as "outcome unknown", never re-sent.
   */
  const failPending = (reason: string) => {
    for (const [id, method] of pending) {
      pending.delete(id);
      void stdio.send({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message:
            method === "tools/call"
              ? `Haven Agent Bridge: ${reason} before the answer arrived. The call may or may not have run; check the current state before retrying.`
              : `Haven Agent Bridge: ${reason}; please retry.`,
        },
      });
    }
  };

  const checkDaemon = async () => {
    if (pending.size === 0) return;
    const now = await findDaemon();
    if (!now) failPending("lost the connection to the bridge");
    else if (address.instance && now.instance !== address.instance) failPending("the bridge restarted");
  };

  const reconnect = () => {
    reconnecting ??= (async () => {
      warn("lost the daemon; reconnecting");
      address = await ensureDaemon();
      await connect();
      if (initialize) {
        const id = `bridge-reinit-${Date.now()}`;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("re-initialize timed out")), 5000);
          replay = {
            id,
            done: () => {
              clearTimeout(timer);
              resolve();
            },
          };
          http!.send({ ...initialize!, id } as JSONRPCMessage).catch(reject);
        });
        replay = null;
        if (initialized) {
          await http!.send({ jsonrpc: "2.0", method: "notifications/initialized" });
        }
        await stdio.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    })().finally(() => {
      reconnecting = null;
    });
    return reconnecting;
  };

  const forward = async (message: JSONRPCMessage) => {
    const m = message as { id?: string | number; method?: string };
    if (m.method === "initialize" && m.id !== undefined) {
      initialize = message as typeof initialize;
    }
    if (m.method === "notifications/initialized") initialized = true;
    if (reconnecting) await reconnecting.catch(() => {});
    const isRequest = m.id !== undefined && m.method !== undefined;
    if (isRequest) pending.set(m.id!, m.method!);
    try {
      await http!.send(message);
    } catch (error) {
      const delivery = deliveryOf(error);
      if (delivery === "other") {
        if (isRequest) pending.delete(m.id!);
        throw error;
      }
      // Sent again only when the daemon certainly never handled it (nothing
      // listening, or a new daemon that did not know the session), or when
      // repeating it has no effect. A write whose fate is unknown is not
      // repeated: it may already have happened.
      const safe = delivery === "not-delivered" || (m.method !== undefined && REPEATABLE.has(m.method));
      await reconnect();
      if (m.method === "initialize") return; // replayed by reconnect
      if (!safe) {
        if (isRequest) pending.delete(m.id!);
        throw new Error(
          m.method === "tools/call"
            ? "lost the connection to the bridge while sending the call. It may or may not have run; check the current state before retrying."
            : "lost the connection to the bridge while sending; please retry.",
        );
      }
      await http!.send(message);
    }
  };

  stdio.onmessage = (message) => {
    forward(message).catch((error: unknown) => {
      const m = message as { id?: string | number; method?: string };
      warn(`forwarding ${m.method ?? "response"} failed: ${String(error)}`);
      if (m.id !== undefined && m.method) {
        void stdio.send({
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32603, message: `Haven Agent Bridge: ${String(error)}` },
        });
      }
    });
  };
  stdio.onclose = () => {
    // End the session so the GUI stops listing this client; never hang on it.
    const ending = (http as StreamableHTTPClientTransport | null)?.terminateSession().catch(() => {});
    void Promise.race([ending, sleep(1000)]).finally(() => process.exit(0));
  };

  await connect();
  await stdio.start();
}

/** Requests that can be sent twice without changing anything. */
const REPEATABLE = new Set([
  "ping",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "notifications/initialized",
]);

/**
 * - `not-delivered`: nothing listened (connection refused) or a restarted
 *   daemon rejected the unknown session before handling anything.
 * - `unknown`: the connection broke after the request may have arrived.
 * - `other`: not a connection problem.
 */
function deliveryOf(error: unknown): "not-delivered" | "unknown" | "other" {
  const cause = (error as { cause?: { code?: string } })?.cause;
  const text = `${String(cause ?? "")} ${String(error)}`;
  if (cause?.code === "ECONNREFUSED" || /ECONNREFUSED|Session not found|\b404\b/.test(text)) return "not-delivered";
  if (/ECONNRESET|EPIPE|socket hang up|fetch failed|terminated|other side closed/i.test(text)) return "unknown";
  return "other";
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
