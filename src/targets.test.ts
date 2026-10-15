import { describe, expect, it } from "vitest";

import type { Target } from "./protocol.js";
import { resolveTarget, toCallResult, toErrorResult, toMcpTool, toolsSignature } from "./targets.js";

function target(partial: Partial<Target> & Pick<Target, "tabId" | "origin">): Target {
  return {
    windowId: 1,
    url: `${partial.origin}/`,
    title: "",
    generation: 1,
    lastActiveAt: 0,
    native: true,
    tools: [],
    ...partial,
  };
}

const local = target({ tabId: 1, origin: "http://localhost:4174", lastActiveAt: 100, tools: [{ name: "haven_x", description: "", inputSchema: {} }] });
const prod = target({ tabId: 2, origin: "https://haven.mindoodb.com", lastActiveAt: 300 });
const prod2 = target({ tabId: 3, origin: "https://haven.mindoodb.com", lastActiveAt: 200 });

describe("resolveTarget", () => {
  it("follows the tab used last", () => {
    expect(resolveTarget([local, prod, prod2], { mode: "active" })?.tabId).toBe(2);
  });

  it("prefers a tab with tools among tabs never seen active", () => {
    const a = target({ tabId: 5, origin: "http://a", tools: [] });
    const b = target({ tabId: 9, origin: "http://b", tools: [{ name: "t", description: "", inputSchema: {} }] });
    expect(resolveTarget([a, b], { mode: "active" })?.tabId).toBe(9);
  });

  it("picks the most recent tab of an origin", () => {
    expect(resolveTarget([local, prod, prod2], { mode: "origin", origin: "https://haven.mindoodb.com" })?.tabId).toBe(2);
    expect(resolveTarget([local], { mode: "origin", origin: "https://haven.mindoodb.com" })).toBeNull();
  });

  it("drops a pinned tab that now shows another origin", () => {
    expect(resolveTarget([local], { mode: "tab", tabId: 1, origin: "http://localhost:4174" })?.tabId).toBe(1);
    expect(resolveTarget([local], { mode: "tab", tabId: 1, origin: "https://haven.mindoodb.com" })).toBeNull();
  });
});

describe("toMcpTool", () => {
  it("maps WebMCP annotations to MCP hints and keeps the originals in _meta", () => {
    const tool = toMcpTool(
      {
        name: "todo_delete",
        description: "Deletes",
        inputSchema: { properties: { id: { type: "string" } } },
        annotations: { consequentialHint: true, untrustedContentHint: true, readOnlyHint: false },
      },
      "http://localhost:4174",
    );
    expect(tool.inputSchema.type).toBe("object");
    expect(tool.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(tool._meta?.["webmcp/origin"]).toBe("http://localhost:4174");
  });
});

describe("results", () => {
  it("passes strings as text and objects as text plus structuredContent", () => {
    expect(toCallResult("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
    expect(toCallResult({ a: 1 })).toEqual({ content: [{ type: "text", text: '{"a":1}' }], structuredContent: { a: 1 } });
    expect(toCallResult([1])).toEqual({ content: [{ type: "text", text: "[1]" }] });
  });

  it("keeps results that already are MCP content", () => {
    const result = { content: [{ type: "text", text: "x" }] };
    expect(toCallResult(result)).toBe(result);
  });

  it("parses Haven's JSON error payload", () => {
    const error = JSON.stringify({ error: "LOCKED", message: "Haven is locked.", contextVersion: 3 });
    expect(toErrorResult(error)).toEqual({
      content: [{ type: "text", text: error }],
      structuredContent: { error: "LOCKED", message: "Haven is locked.", contextVersion: 3 },
      isError: true,
    });
    expect(toErrorResult("boom").structuredContent).toBeUndefined();
  });
});

describe("toolsSignature", () => {
  it("changes with the tab, the tools and the meta tools, not with activity", () => {
    const base = toolsSignature(local, ["bridge_status"]);
    expect(toolsSignature({ ...local, lastActiveAt: 999, generation: 7 }, ["bridge_status"])).toBe(base);
    expect(toolsSignature({ ...local, tools: [] }, ["bridge_status"])).not.toBe(base);
    expect(toolsSignature(prod, ["bridge_status"])).not.toBe(base);
    expect(toolsSignature(local, ["bridge_status", "bridge_tool_call"])).not.toBe(base);
  });
});
