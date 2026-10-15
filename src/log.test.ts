import { describe, expect, it } from "vitest";

import { CallLog, errorCode, redactEntry } from "./log.js";

function makeLog(recording: boolean) {
  return new CallLog({ limit: () => 100, recording: () => recording, toFile: () => false });
}

describe("CallLog", () => {
  it("keeps payloads only while recording", () => {
    const on = makeLog(true);
    on.startCall({ client: "goose", origin: "http://a", tabId: 1, tool: "t", args: { q: 1 } })({ ok: true, result: { r: 2 }, bytes: 10 });
    const [entryOn] = on.list().filter((e) => e.kind === "call");
    expect(entryOn).toMatchObject({ args: { q: 1 }, result: { r: 2 }, status: "ok", bytes: 10 });

    const off = makeLog(false);
    off.startCall({ client: "goose", origin: "http://a", tabId: 1, tool: "t", args: { q: 1 } })({ ok: false, error: "secret text", bytes: 4 });
    off.startCall({ client: "goose", origin: "http://a", tabId: 1, tool: "t", args: {} })({
      ok: false,
      error: JSON.stringify({ error: "NOT_FOUND", message: "No note 'Salary 2027'" }),
      bytes: 4,
    });
    off.startCall({ client: "goose", origin: "http://a", tabId: 1, tool: "t", args: {} })({ ok: false, error: "The tab did not answer", bytes: 4, fromBridge: true });
    const [entryOff, coded, bridge] = off.list().filter((e) => e.kind === "call");
    expect(entryOff).toMatchObject({ payloadOmitted: true, status: "error", error: "error (message not recorded)" });
    expect(entryOff?.args).toBeUndefined();
    expect(coded?.error).toBe("NOT_FOUND (message not recorded)");
    expect(bridge?.error).toBe("The tab did not answer");
  });

  it("counts per tool and per client", () => {
    const log = makeLog(false);
    for (const ok of [true, true, false]) {
      const done = log.startCall({ client: "goose", origin: "http://a", tabId: 1, tool: "t", args: {} });
      done(ok ? { ok: true, result: null, bytes: 100 } : { ok: false, error: "x", bytes: 20 });
    }
    const stats = log.stats();
    expect(stats.totals).toMatchObject({ calls: 3, errors: 1 });
    expect(stats.tools[0]).toMatchObject({ tool: "t", origin: "http://a", calls: 3, errors: 1, avgBytes: 73 });
    expect(stats.clients[0]).toMatchObject({ client: "goose", calls: 3, errors: 1 });
  });

  it("drops the oldest entries beyond the limit", () => {
    const log = makeLog(false);
    for (let i = 0; i < 150; i++) log.add({ kind: "note", status: "info", title: String(i) });
    expect(log.list()).toHaveLength(100);
    expect(log.list()[0]?.title).toBe("50");
  });

  it("redacts payloads for export", () => {
    const entry = redactEntry({ id: 1, at: 0, kind: "call", status: "ok", title: "t", args: { secret: "x" }, error: "abc" });
    expect(entry.args).toBe("[redacted: 14 chars]");
    expect(entry.error).toBe("[redacted: 3 chars]");
  });
});

describe("errorCode", () => {
  it("keeps only well-formed codes", () => {
    expect(errorCode('{"error":"LOCKED","message":"x"}')).toBe("LOCKED (message not recorded)");
    expect(errorCode('{"error":"secret value here"}')).toBe("error (message not recorded)");
    expect(errorCode("plain")).toBe("error (message not recorded)");
  });
});
