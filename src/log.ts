/**
 * The debug log behind the GUI: every call with its client, tab, arguments,
 * response and duration, plus the protocol events around it (tool lists sent,
 * list_changed, tab snapshots, sessions). A ring buffer in memory, optionally
 * mirrored to an NDJSON file.
 *
 * Arguments and responses are user data, so they are only kept while
 * recording is on; without it a call is logged with its metadata alone.
 * Statistics are counted either way and survive the ring buffer.
 */
import { appendFile } from "node:fs";
import { join } from "node:path";

import { ensureHome } from "./config.js";
import { safeJson } from "./targets.js";

export type LogKind = "call" | "tools_list" | "list_changed" | "targets" | "session" | "extension" | "note";

export type LogEntry = {
  id: number;
  at: number;
  kind: LogKind;
  status: "running" | "ok" | "error" | "info";
  title: string;
  sessionId?: string;
  client?: string;
  origin?: string;
  tabId?: number;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  durationMs?: number;
  /** Size of the response as sent to the client, in bytes. */
  bytes?: number;
  /** Arguments and response were not kept (recording was off). */
  payloadOmitted?: boolean;
  detail?: unknown;
};

/** Long payloads are cut so the GUI stays responsive. */
const MAX_PAYLOAD_CHARS = 50_000;
const DURATION_SAMPLES = 500;

type ToolStats = {
  tool: string;
  origin: string;
  calls: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  totalBytes: number;
  durations: number[];
  lastAt: number;
};

type ClientStats = { client: string; calls: number; errors: number; totalMs: number; lastAt: number };

export type StatsReport = {
  since: number;
  totals: { calls: number; errors: number; toolsLists: number; listChanged: number };
  tools: Array<{
    tool: string;
    origin: string;
    calls: number;
    errors: number;
    errorRate: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
    avgBytes: number;
    lastAt: number;
  }>;
  clients: Array<{ client: string; calls: number; errors: number; avgMs: number; lastAt: number }>;
};

export class CallLog {
  private entries: LogEntry[] = [];
  private counter = 0;
  private listeners = new Set<(entry: LogEntry) => void>();
  private toolStats = new Map<string, ToolStats>();
  private clientStats = new Map<string, ClientStats>();
  private totals = { calls: 0, errors: 0, toolsLists: 0, listChanged: 0 };
  private since = Date.now();

  constructor(
    private options: { limit: () => number; recording: () => boolean; toFile: () => boolean },
  ) {}

  onEntry(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(sinceId = 0): LogEntry[] {
    return this.entries.filter((e) => e.id > sinceId);
  }

  clear(): void {
    this.entries = [];
    this.toolStats.clear();
    this.clientStats.clear();
    this.totals = { calls: 0, errors: 0, toolsLists: 0, listChanged: 0 };
    this.since = Date.now();
    this.add({ kind: "note", status: "info", title: "log cleared" });
  }

  add(entry: Omit<LogEntry, "id" | "at">): LogEntry {
    this.counter += 1;
    const full: LogEntry = { ...entry, id: this.counter, at: Date.now() };
    if (full.kind === "tools_list") this.totals.toolsLists += 1;
    if (full.kind === "list_changed") this.totals.listChanged += 1;
    this.entries.push(full);
    const limit = Math.max(100, this.options.limit());
    if (this.entries.length > limit) {
      this.entries.splice(0, this.entries.length - limit);
    }
    this.emit(full);
    return full;
  }

  /** Starts a call entry; returns a function that completes it. */
  startCall(call: {
    sessionId?: string;
    client: string;
    origin: string;
    tabId: number;
    tool: string;
    args: unknown;
  }): (
    outcome:
      | { ok: true; result: unknown; bytes: number }
      | { ok: false; error: string; bytes: number; fromBridge?: boolean },
  ) => void {
    const recording = this.options.recording();
    const entry = this.add({
      kind: "call",
      status: "running",
      title: call.tool,
      sessionId: call.sessionId,
      client: call.client,
      origin: call.origin,
      tabId: call.tabId,
      tool: call.tool,
      ...(recording ? { args: clip(call.args) } : { payloadOmitted: true }),
    });
    const startedAt = Date.now();
    return (outcome) => {
      const durationMs = Date.now() - startedAt;
      entry.status = outcome.ok ? "ok" : "error";
      entry.durationMs = durationMs;
      entry.bytes = outcome.bytes;
      if (recording) {
        if (outcome.ok) entry.result = clip(outcome.result);
        else entry.error = clipText(outcome.error);
      } else if (!outcome.ok) {
        // A page's error text can quote document content; without recording
        // only its code is kept. The bridge's own messages carry no user data.
        entry.error = outcome.fromBridge ? clipText(outcome.error) : errorCode(outcome.error);
      }
      this.count(call, outcome.ok, durationMs, outcome.bytes);
      this.emit(entry);
    };
  }

  stats(): StatsReport {
    const percentile = (values: number[], p: number) => {
      if (values.length === 0) return 0;
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
    };
    return {
      since: this.since,
      totals: { ...this.totals },
      tools: [...this.toolStats.values()]
        .map((s) => ({
          tool: s.tool,
          origin: s.origin,
          calls: s.calls,
          errors: s.errors,
          errorRate: s.calls ? s.errors / s.calls : 0,
          avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
          p50Ms: percentile(s.durations, 50),
          p95Ms: percentile(s.durations, 95),
          maxMs: s.maxMs,
          avgBytes: s.calls ? Math.round(s.totalBytes / s.calls) : 0,
          lastAt: s.lastAt,
        }))
        .sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool)),
      clients: [...this.clientStats.values()]
        .map((s) => ({
          client: s.client,
          calls: s.calls,
          errors: s.errors,
          avgMs: s.calls ? Math.round(s.totalMs / s.calls) : 0,
          lastAt: s.lastAt,
        }))
        .sort((a, b) => b.calls - a.calls),
    };
  }

  private count(
    call: { client: string; origin: string; tool: string },
    ok: boolean,
    durationMs: number,
    bytes: number,
  ) {
    const now = Date.now();
    this.totals.calls += 1;
    if (!ok) this.totals.errors += 1;
    const key = `${call.origin} ${call.tool}`;
    const tool = this.toolStats.get(key) ?? {
      tool: call.tool,
      origin: call.origin,
      calls: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      totalBytes: 0,
      durations: [],
      lastAt: 0,
    };
    tool.calls += 1;
    if (!ok) tool.errors += 1;
    tool.totalMs += durationMs;
    tool.maxMs = Math.max(tool.maxMs, durationMs);
    tool.totalBytes += bytes;
    tool.durations.push(durationMs);
    if (tool.durations.length > DURATION_SAMPLES) tool.durations.shift();
    tool.lastAt = now;
    this.toolStats.set(key, tool);

    const client = this.clientStats.get(call.client) ?? { client: call.client, calls: 0, errors: 0, totalMs: 0, lastAt: 0 };
    client.calls += 1;
    if (!ok) client.errors += 1;
    client.totalMs += durationMs;
    client.lastAt = now;
    this.clientStats.set(call.client, client);
  }

  private emit(entry: LogEntry) {
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // A broken GUI stream must not break calls.
      }
    }
    if (this.options.toFile() && entry.status !== "running") {
      appendFile(join(ensureHome(), "calls.ndjson"), `${safeJson(entry)}\n`, { mode: 0o600 }, () => {});
    }
  }
}

/** Replaces arguments, results and error texts with their size. */
export function redactEntry(entry: LogEntry): LogEntry {
  const copy: LogEntry = { ...entry };
  for (const key of ["args", "result"] as const) {
    if (copy[key] !== undefined) copy[key] = `[redacted: ${safeJson(copy[key]).length} chars]`;
  }
  if (copy.error !== undefined) copy.error = `[redacted: ${copy.error.length} chars]`;
  return copy;
}

/** `LOCKED`, `NOT_FOUND` … from Haven's JSON error payload, never the message. */
export function errorCode(error: string): string {
  try {
    const parsed = JSON.parse(error) as { error?: unknown };
    if (typeof parsed?.error === "string" && /^[A-Z][A-Z0-9_]{1,40}$/.test(parsed.error)) {
      return `${parsed.error} (message not recorded)`;
    }
  } catch {
    // Plain text.
  }
  return "error (message not recorded)";
}

function clip(value: unknown): unknown {
  const text = safeJson(value);
  if (text.length <= MAX_PAYLOAD_CHARS) return value;
  return `${text.slice(0, MAX_PAYLOAD_CHARS)}… (${text.length - MAX_PAYLOAD_CHARS} more characters)`;
}

function clipText(text: string): string {
  return text.length <= MAX_PAYLOAD_CHARS
    ? text
    : `${text.slice(0, MAX_PAYLOAD_CHARS)}… (${text.length - MAX_PAYLOAD_CHARS} more characters)`;
}
