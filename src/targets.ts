/**
 * Pure logic: which tab a selection points at, and how a page's WebMCP tools
 * look to an MCP client. No I/O here, so it is tested directly.
 */
import type { Selection, Target, WebMcpTool } from "./protocol.js";

/**
 * What a client saw in its last tool list: the tab, the document in it, and
 * each tool's definition. Calls go there and only there.
 */
export type Binding = {
  tabId: number;
  origin: string;
  documentId?: string;
  tools: Map<string, string>;
};

export function bindingFor(target: Target): Binding {
  return {
    tabId: target.tabId,
    origin: target.origin,
    documentId: target.documentId,
    tools: new Map(target.tools.map((t) => [t.name, toolHash(t)])),
  };
}

/**
 * The tab a call from a client bound to `binding` may run in, or why not.
 * The selection may point elsewhere by now (the user switched tabs); the call
 * still goes to the tab, document and tool definition the client listed, or
 * is refused.
 */
export function checkBinding(
  targets: Target[],
  binding: Binding,
  name: string,
): { ok: true; target: Target } | { ok: false; message: string } {
  const listed = binding.tools.get(name);
  if (listed === undefined) {
    return { ok: false, message: `"${name}" was not in the tool list you received.` };
  }
  const target = targets.find((t) => t.tabId === binding.tabId);
  if (!target || target.origin !== binding.origin) {
    return { ok: false, message: `The tab you listed tools from (${binding.origin}) was closed or navigated away.` };
  }
  if (binding.documentId && target.documentId !== binding.documentId) {
    return { ok: false, message: `The page you listed tools from (${binding.origin}) was reloaded since then.` };
  }
  const tool = target.tools.find((t) => t.name === name);
  if (!tool || toolHash(tool) !== listed) {
    return { ok: false, message: `"${name}" changed or was removed in ${binding.origin} since you listed it.` };
  }
  return { ok: true, target };
}

/** The tab a selection resolves to right now, or `null`. */
export function resolveTarget(targets: Target[], selection: Selection): Target | null {
  switch (selection.mode) {
    case "tab": {
      const tab = targets.find((t) => t.tabId === selection.tabId);
      // A pinned tab that navigated to another origin is not the target any more.
      return tab && tab.origin === selection.origin ? tab : null;
    }
    case "origin":
      return mostRecentlyActive(targets.filter((t) => t.origin === selection.origin));
    case "active":
      return mostRecentlyActive(targets);
  }
}

/**
 * The tab the user looked at last; among tabs never seen active, the one with
 * tools wins, then the lowest tab id, so the choice is stable.
 */
function mostRecentlyActive(targets: Target[]): Target | null {
  let best: Target | null = null;
  for (const t of targets) {
    if (!best) {
      best = t;
      continue;
    }
    if (t.lastActiveAt !== best.lastActiveAt) {
      if (t.lastActiveAt > best.lastActiveAt) best = t;
      continue;
    }
    const tTools = t.tools.length > 0 ? 1 : 0;
    const bestTools = best.tools.length > 0 ? 1 : 0;
    if (tTools !== bestTools) {
      if (tTools > bestTools) best = t;
      continue;
    }
    if (t.tabId < best.tabId) best = t;
  }
  return best;
}

export function describeSelection(selection: Selection): string {
  switch (selection.mode) {
    case "active":
      return "the allowed tab the user activated last";
    case "origin":
      return `the most recently used tab on ${selection.origin}`;
    case "tab":
      return `tab ${selection.tabId} on ${selection.origin}`;
  }
}

export function sameSelection(a: Selection, b: Selection): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function isSelection(value: unknown): value is Selection {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === "active") return true;
  if (v.mode === "origin") return typeof v.origin === "string";
  if (v.mode === "tab") return typeof v.tabId === "number" && typeof v.origin === "string";
  return false;
}

/** An MCP tool definition as `tools/list` returns it. */
export type McpTool = {
  name: string;
  description?: string;
  inputSchema: { type: "object"; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; openWorldHint?: boolean };
  _meta?: Record<string, unknown>;
};

/**
 * WebMCP → MCP. `readOnlyHint` maps 1:1, `consequentialHint` (the user would
 * want to confirm) becomes `destructiveHint`, `untrustedContentHint` (the
 * result carries text other people wrote) becomes `openWorldHint`. The page's
 * own annotations and the origin travel along in `_meta`.
 */
export function toMcpTool(tool: WebMcpTool, origin: string): McpTool {
  const schema = tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema : {};
  const annotations: NonNullable<McpTool["annotations"]> = {};
  const a = tool.annotations ?? {};
  if (typeof a.readOnlyHint === "boolean") annotations.readOnlyHint = a.readOnlyHint;
  if (typeof a.consequentialHint === "boolean") annotations.destructiveHint = a.consequentialHint;
  if (typeof a.untrustedContentHint === "boolean") annotations.openWorldHint = a.untrustedContentHint;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...schema, type: "object" },
    ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
    _meta: {
      "webmcp/origin": origin,
      ...(tool.annotations ? { "webmcp/annotations": tool.annotations } : {}),
    },
  };
}

/** Content of a successful call as MCP `CallToolResult`. */
export function toCallResult(result: unknown): {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  if (looksLikeCallResult(result)) {
    return result as { content: Array<Record<string, unknown>> };
  }
  if (typeof result === "string") {
    return { content: [{ type: "text", text: result }] };
  }
  const text = safeJson(result ?? null);
  return {
    content: [{ type: "text", text }],
    ...(isPlainObject(result) ? { structuredContent: result } : {}),
  };
}

/**
 * Content of a failed call. Haven throws its error payload as a JSON string
 * (`{ error, message, requiredAction?, contextVersion }`); that object also
 * goes into `structuredContent`.
 */
export function toErrorResult(error: string): {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError: true;
} {
  let structured: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(error);
    if (isPlainObject(parsed)) structured = parsed;
  } catch {
    // Plain message.
  }
  return { content: [{ type: "text", text: error }], ...(structured ? { structuredContent: structured } : {}), isError: true };
}

function looksLikeCallResult(value: unknown): boolean {
  if (!isPlainObject(value) || !Array.isArray(value.content)) return false;
  return value.content.every(
    (item) => isPlainObject(item) && typeof item.type === "string",
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

/** Fingerprint of one tool definition: a call must match the definition the client saw. */
export function toolHash(tool: WebMcpTool): string {
  return safeJson([tool.name, tool.description, tool.inputSchema, tool.annotations ?? null]);
}

/** Stable fingerprint of what `tools/list` would return; changes trigger list_changed. */
export function toolsSignature(target: Target | null, extraNames: string[]): string {
  return safeJson({
    tab: target ? [target.tabId, target.origin, target.documentId ?? null] : null,
    tools: target?.tools ?? [],
    extra: extraNames,
  });
}
