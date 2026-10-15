/**
 * Files in the bridge's home folder (`~/.haven-agent-bridge`, or
 * `HAVEN_AGENT_BRIDGE_HOME`): the daemon's port and token for the shim, the
 * settings the user changes in the popup or the GUI, and the daemon log.
 * Folder 0700, files 0600: the token lets anyone call tools in the browser.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Selection } from "./protocol.js";

export function bridgeHome(): string {
  return process.env.HAVEN_AGENT_BRIDGE_HOME || join(homedir(), ".haven-agent-bridge");
}

export function ensureHome(): string {
  const dir = bridgeHome();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if ((statSync(dir).mode & 0o777) !== 0o700) {
    chmodSync(dir, 0o700);
  }
  return dir;
}

export function writePrivate(name: string, data: string): void {
  const file = join(ensureHome(), name);
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function readPrivate(name: string): string | null {
  try {
    return readFileSync(join(bridgeHome(), name), "utf8").trim();
  } catch {
    return null;
  }
}

/** The token survives restarts so a running shim keeps working. */
export function loadOrCreateToken(): string {
  const existing = readPrivate("token");
  if (existing && /^[0-9a-f]{64}$/.test(existing)) {
    return existing;
  }
  const token = randomBytes(32).toString("hex");
  writePrivate("token", token);
  return token;
}

export type BridgeSettings = {
  /** Which tab new clients talk to. */
  defaultSelection: Selection;
  /** Record arguments and results of calls (the debug log); off by default. */
  recording: boolean;
  /** Offer `bridge_tools_list` / `bridge_tool_call` for clients without list_changed. */
  fallbackTools: boolean;
  /** Entries the debug log keeps in memory. */
  logLimit: number;
  /** Also append the debug log to `calls.ndjson` in the home folder. */
  logFile: boolean;
  /** How long a tool call may take (the user may have to confirm in the page). */
  callTimeoutMs: number;
};

export const DEFAULT_SETTINGS: BridgeSettings = {
  defaultSelection: { mode: "active" },
  recording: false,
  fallbackTools: false,
  logLimit: 2000,
  logFile: false,
  callTimeoutMs: 180_000,
};

export function loadSettings(): BridgeSettings {
  const raw = readPrivate("settings.json");
  if (!raw) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: BridgeSettings): void {
  writePrivate("settings.json", `${JSON.stringify(settings, null, 2)}\n`);
}
