/**
 * Wire protocol between the browser extension and the daemon (one WebSocket).
 *
 * The extension is the only source of truth about tabs: it sends a full
 * snapshot of every allowed tab and its WebMCP tools whenever something
 * changes. The daemon decides which tab a client talks to and sends calls
 * that name both the tab and the origin it expects there, so a call never
 * runs in a tab that has navigated elsewhere.
 */

export const PROTOCOL_VERSION = 1;
export const BRIDGE_NAME = "haven-agent-bridge";
/** Ports the daemon tries, in order; the extension scans the same range. */
export const PORT_FIRST = 13300;
export const PORT_LAST = 13309;

/** WebMCP `ToolAnnotations` as the page declared them. */
export type WebMcpAnnotations = {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
  [key: string]: unknown;
};

export type WebMcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: WebMcpAnnotations;
};

/** One allowed browser tab with the tools its page registered. */
export type Target = {
  tabId: number;
  windowId: number;
  origin: string;
  url: string;
  title: string;
  /** Counts registrations in this tab since the extension started. */
  generation: number;
  /** When the user last activated this tab (ms); 0 if never seen active. */
  lastActiveAt: number;
  /** Whether the page has WebMCP natively or got the extension's polyfill. */
  native: boolean;
  tools: WebMcpTool[];
};

/** Which tab a client talks to. */
export type Selection =
  | { mode: "active" }
  | { mode: "origin"; origin: string }
  | { mode: "tab"; tabId: number; origin: string };

// --- extension -> daemon ---

export type HelloMessage = { type: "hello"; protocol: number; extensionVersion: string; origins: string[] };
export type TargetsMessage = { type: "targets"; targets: Target[] };
export type ToolResultMessage =
  | { type: "tool_result"; callId: string; ok: true; result: unknown }
  | { type: "tool_result"; callId: string; ok: false; error: string };
export type SetDefaultSelectionMessage = { type: "set_default_selection"; selection: Selection };
export type SetRecordingMessage = { type: "set_recording"; recording: boolean };
export type PongMessage = { type: "pong" };

export type ExtensionMessage =
  | HelloMessage
  | TargetsMessage
  | ToolResultMessage
  | SetDefaultSelectionMessage
  | SetRecordingMessage
  | PongMessage;

// --- daemon -> extension ---

export type CallMessage = {
  type: "call";
  callId: string;
  tabId: number;
  origin: string;
  name: string;
  args: Record<string, unknown>;
};
/** What the popup shows: the default selection, the tab it resolves to, recording. */
export type StateMessage = {
  type: "state";
  defaultSelection: Selection;
  resolvedTabId: number | null;
  recording: boolean;
  sessions: number;
  uiUrl: string;
};
export type PingMessage = { type: "ping" };

export type DaemonMessage = CallMessage | StateMessage | PingMessage;
