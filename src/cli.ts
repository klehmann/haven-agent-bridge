#!/usr/bin/env node
/**
 * haven-agent-bridge            stdio MCP server for Goose, Claude Code & co.
 * haven-agent-bridge daemon     run the bridge in the foreground
 * haven-agent-bridge ui         open the debug GUI
 * haven-agent-bridge status     print the bridge state as JSON
 */
import { spawn } from "node:child_process";

import { BRIDGE_VERSION, BridgeDaemon } from "./daemon.js";
import { acquireDaemonLock, ensureDaemon, findDaemon, runShim } from "./shim.js";

const HELP = `haven-agent-bridge ${BRIDGE_VERSION}

Bridges the WebMCP tools of one browser tab to MCP clients.

Usage:
  haven-agent-bridge              stdio MCP server (put this in your MCP client)
  haven-agent-bridge daemon       run the bridge in the foreground
      --port <n>                  fixed port (default: first free of 13300-13309)
      --record                    record call arguments and responses from the start
      --auto-exit                 exit after 30 idle minutes (used by the stdio server)
      --quiet                     no log lines on stderr
  haven-agent-bridge ui           open the debug GUI in the browser
  haven-agent-bridge status       print the bridge state as JSON
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case undefined:
    case "stdio":
      return runShim();
    case "daemon":
      return runDaemon(rest);
    case "ui": {
      const address = await ensureDaemon();
      const url = `http://127.0.0.1:${address.port}/ui#token=${address.token}`;
      process.stdout.write(`${url}\n`);
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
      return;
    }
    case "status": {
      const address = await findDaemon();
      if (!address) {
        process.stdout.write("not running\n");
        process.exitCode = 1;
        return;
      }
      const res = await fetch(`http://127.0.0.1:${address.port}/api/state`, {
        headers: { authorization: `Bearer ${address.token}` },
      });
      process.stdout.write(`${JSON.stringify(await res.json(), null, 2)}\n`);
      return;
    }
    case "--version":
    case "-v":
      process.stdout.write(`${BRIDGE_VERSION}\n`);
      return;
    default:
      process.stdout.write(HELP);
      if (command !== "--help" && command !== "-h") process.exitCode = 1;
  }
}

async function runDaemon(args: string[]) {
  const flag = (name: string) => args.includes(name);
  const portIndex = args.indexOf("--port");
  const port = portIndex >= 0 ? Number(args[portIndex + 1]) : undefined;

  const release = acquireDaemonLock();
  if (!release) {
    process.stderr.write("[haven-agent-bridge] another daemon is already running\n");
    return;
  }
  const daemon = new BridgeDaemon({
    port,
    autoExit: flag("--auto-exit"),
    recording: flag("--record"),
    quiet: flag("--quiet"),
  });
  const shutdown = () => {
    void daemon.stop().finally(() => {
      release();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", release);
  try {
    await daemon.start();
  } catch (error) {
    release();
    throw error;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`[haven-agent-bridge] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
