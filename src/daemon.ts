/**
 * The long-running bridge process on 127.0.0.1.
 *
 * - `/ext` — WebSocket to the browser extension (one at a time; the newest wins).
 * - `/mcp` — MCP over Streamable HTTP. Every client gets its own session and
 *   sees the tools of exactly one tab: its own selection, or the default one.
 *   Clients that speak stdio reach it through the shim (`haven-agent-bridge`
 *   without arguments).
 * - `/ui`, `/api/*` — the debug GUI and its data.
 * - `/.well-known/haven-agent-bridge` — lets the extension find the port and
 *   the token. Web pages are turned away by their Origin header.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  isInitializeRequest,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";

import {
  loadOrCreateToken,
  loadSettings,
  saveSettings,
  writePrivate,
  type BridgeSettings,
} from "./config.js";
import { CallLog, redactEntry, type LogEntry } from "./log.js";
import {
  BRIDGE_NAME,
  PORT_FIRST,
  PORT_LAST,
  PROTOCOL_VERSION,
  type DaemonMessage,
  type ExtensionMessage,
  type Selection,
  type Target,
} from "./protocol.js";
import {
  describeSelection,
  isSelection,
  resolveTarget,
  safeJson,
  sameSelection,
  toCallResult,
  toErrorResult,
  toMcpTool,
  toolsSignature,
  type McpTool,
} from "./targets.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRIDGE_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }).version;
  } catch {
    return "0.0.0";
  }
})();

const LIST_CHANGED_DEBOUNCE_MS = 150;
const EXTENSION_PING_MS = 20_000;
const EXTENSION_WAIT_MS = 3_000;
const AUTO_EXIT_IDLE_MS = 30 * 60_000;
const SESSION_IDLE_MS = 12 * 60 * 60_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const GUI_CLIENT = "debug-gui";

const META_STATUS = "bridge_status";
const META_TARGETS = "bridge_targets_list";
const META_TOOLS = "bridge_tools_list";
const META_CALL = "bridge_tool_call";

const SERVER_INSTRUCTIONS =
  "Tools from one web page open in the user's browser (usually Haven), bridged from WebMCP. " +
  "Which browser tab they come from is chosen by the user in the Haven Agent Bridge extension or its debug GUI; " +
  "when the tab changes, the tool list changes. Call bridge_status to see which tab is connected.";

type Session = {
  id: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
  /** `null` = follow the default selection. */
  selection: Selection | null;
  createdAt: number;
  lastSeenAt: number;
  lastListedSignature?: string;
  lastNotifiedSignature?: string;
  notifyTimer?: ReturnType<typeof setTimeout>;
};

type PendingCall = {
  tabId: number;
  resolve: (outcome: { ok: true; result: unknown } | { ok: false; error: string }) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type DaemonOptions = {
  /** Fixed port; otherwise the first free one from 13300–13309. */
  port?: number;
  /** Exit after 30 minutes without MCP sessions and GUI viewers (started by the shim). */
  autoExit?: boolean;
  /** Turn recording on for this run, whatever the settings say. */
  recording?: boolean;
  quiet?: boolean;
};

export class BridgeDaemon {
  readonly token = loadOrCreateToken();
  settings: BridgeSettings = loadSettings();
  port = 0;
  private http: HttpServer | null = null;
  private wss = new WebSocketServer({ noServer: true });
  private extension: WebSocket | null = null;
  private extensionInfo: { version: string; origins: string[]; connectedAt: number } | null = null;
  private targets: Target[] = [];
  private targetsSummary = "";
  private pending = new Map<string, PendingCall>();
  private sessions = new Map<string, Session>();
  private guiStreams = new Set<ServerResponse>();
  private lastActivityAt = Date.now();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  readonly log: CallLog;

  constructor(private options: DaemonOptions = {}) {
    if (options.recording) this.settings.recording = true;
    this.log = new CallLog({
      limit: () => this.settings.logLimit,
      recording: () => this.settings.recording,
      toFile: () => this.settings.logFile,
    });
    this.log.onEntry((entry) => this.broadcastGui("entry", entry));
  }

  // --- lifecycle ---

  async start(): Promise<number> {
    const ports = this.options.port ? [this.options.port] : range(PORT_FIRST, PORT_LAST);
    let lastError: unknown;
    for (const port of ports) {
      try {
        await this.listen(port);
        this.port = port;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.port) {
      throw new Error(`No free port in ${ports.join(", ")}: ${String(lastError)}`);
    }
    writePrivate("port", String(this.port));
    this.timers.push(setInterval(() => this.pingExtension(), EXTENSION_PING_MS));
    this.timers.push(setInterval(() => this.expireSessions(), 60_000));
    if (this.options.autoExit) {
      this.timers.push(setInterval(() => this.exitWhenIdle(), 60_000));
    }
    this.log.add({ kind: "note", status: "info", title: `bridge ${BRIDGE_VERSION} listening on 127.0.0.1:${this.port}` });
    this.say(`[haven-agent-bridge] listening on http://127.0.0.1:${this.port} (GUI: ${this.uiUrl()})`);
    return this.port;
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    for (const session of this.sessions.values()) {
      await session.transport.close().catch(() => {});
    }
    for (const res of this.guiStreams) res.end();
    this.extension?.close();
    this.wss.close();
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  uiUrl(): string {
    return `http://127.0.0.1:${this.port}/ui#token=${this.token}`;
  }

  private listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        this.handleHttp(req, res).catch((error) => {
          this.say(`[haven-agent-bridge] request failed: ${String(error)}`);
          if (!res.headersSent) sendJson(res, 500, { error: String(error) });
          else res.end();
        });
      });
      server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        this.http = server;
        resolve();
      });
    });
  }

  /**
   * Clients that went away without ending their session (most HTTP clients
   * just close) would otherwise stay listed forever. A client that comes
   * back later gets "session not found" and initializes again; the shim
   * does that on its own.
   */
  private expireSessions() {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const session of [...this.sessions.values()]) {
      if (session.lastSeenAt < cutoff) {
        void session.transport.close().catch(() => {});
        this.dropSession(session.id);
      }
    }
  }

  private exitWhenIdle() {
    if (this.sessions.size > 0 || this.guiStreams.size > 0) {
      this.lastActivityAt = Date.now();
      return;
    }
    if (Date.now() - this.lastActivityAt > AUTO_EXIT_IDLE_MS) {
      this.say("[haven-agent-bridge] idle, exiting");
      void this.stop().then(() => process.exit(0));
    }
  }

  private say(line: string) {
    if (!this.options.quiet) process.stderr.write(`${line}\n`);
  }

  // --- HTTP ---

  private async handleHttp(req: IncomingMessage, res: ServerResponse) {
    if (!this.hostAllowed(req)) {
      return sendJson(res, 403, { error: "Host not allowed" });
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    if (path === "/.well-known/haven-agent-bridge") {
      const origin = req.headers.origin;
      if (origin && !origin.startsWith("chrome-extension://")) {
        return sendJson(res, 403, { error: "Origin not allowed" });
      }
      return sendJson(res, 200, {
        name: BRIDGE_NAME,
        version: BRIDGE_VERSION,
        protocol: PROTOCOL_VERSION,
        port: this.port,
        token: this.token,
      });
    }
    if (path === "/" || path === "/ui" || path === "/ui/") {
      return sendFile(res, "index.html", "text/html; charset=utf-8");
    }
    if (path === "/ui/app.js") return sendFile(res, "app.js", "text/javascript; charset=utf-8");
    if (path === "/ui/style.css") return sendFile(res, "style.css", "text/css; charset=utf-8");

    if (!this.originAllowed(req)) {
      return sendJson(res, 403, { error: "Origin not allowed" });
    }
    if (path === "/mcp") {
      if (!this.authorized(req, url, false)) return sendJson(res, 401, { error: "Missing or wrong token" });
      return this.handleMcp(req, res);
    }
    if (path.startsWith("/api/")) {
      if (!this.authorized(req, url, path === "/api/events")) {
        return sendJson(res, 401, { error: "Missing or wrong token" });
      }
      return this.handleApi(req, res, url);
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  /** DNS rebinding guard: only our own address is a valid Host. */
  private hostAllowed(req: IncomingMessage): boolean {
    const host = req.headers.host;
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  /** No web page may talk to the bridge; only the extension, local processes and the GUI itself. */
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    if (origin.startsWith("chrome-extension://")) return true;
    return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
  }

  private authorized(req: IncomingMessage, url: URL, allowQuery: boolean): boolean {
    const header = req.headers.authorization;
    if (header === `Bearer ${this.token}`) return true;
    if (req.headers["x-bridge-token"] === this.token) return true;
    return allowQuery && url.searchParams.get("token") === this.token;
  }

  private handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const origin = req.headers.origin;
    if (
      url.pathname !== "/ext" ||
      !this.hostAllowed(req) ||
      url.searchParams.get("token") !== this.token ||
      (origin !== undefined && !origin.startsWith("chrome-extension://"))
    ) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attachExtension(ws));
  }

  // --- extension ---

  private attachExtension(ws: WebSocket) {
    if (this.extension && this.extension !== ws) {
      // A reloaded extension reconnects before the old socket times out.
      this.extension.close(4000, "replaced");
    }
    this.extension = ws;
    let alive = true;
    (ws as WebSocket & { _bridgeAlive?: () => boolean })._bridgeAlive = () => alive;
    ws.on("message", (data) => {
      alive = true;
      let msg: ExtensionMessage;
      try {
        msg = JSON.parse(String(data)) as ExtensionMessage;
      } catch {
        return;
      }
      this.onExtensionMessage(ws, msg);
    });
    ws.on("pong", () => {
      alive = true;
    });
    ws.on("close", () => {
      if (this.extension !== ws) return;
      this.extension = null;
      this.extensionInfo = null;
      this.log.add({ kind: "extension", status: "info", title: "extension disconnected" });
      // Tabs are unknown until the extension is back; keep them so a short
      // service-worker restart does not flap every client's tool list, but
      // fail calls that were waiting for an answer.
      for (const [callId, call] of this.pending) {
        clearTimeout(call.timer);
        call.resolve({ ok: false, error: "The browser extension disconnected before the tab answered." });
        this.pending.delete(callId);
      }
      this.pushState();
    });
    this.log.add({ kind: "extension", status: "info", title: "extension connected" });
    this.sendToExtension(this.stateMessage());
  }

  private onExtensionMessage(ws: WebSocket, msg: ExtensionMessage) {
    if (ws !== this.extension) return;
    switch (msg.type) {
      case "hello":
        this.extensionInfo = { version: msg.extensionVersion, origins: msg.origins, connectedAt: Date.now() };
        this.log.add({
          kind: "extension",
          status: "info",
          title: `extension ${msg.extensionVersion} (protocol ${msg.protocol})`,
          detail: { origins: msg.origins },
        });
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.log.add({
            kind: "note",
            status: "error",
            title: `protocol mismatch: extension ${msg.protocol}, bridge ${PROTOCOL_VERSION}; update both`,
          });
        }
        this.pushState();
        return;
      case "targets":
        this.updateTargets(Array.isArray(msg.targets) ? msg.targets : []);
        return;
      case "tool_result": {
        const call = this.pending.get(msg.callId);
        if (!call) return;
        clearTimeout(call.timer);
        this.pending.delete(msg.callId);
        call.resolve(msg.ok ? { ok: true, result: msg.result } : { ok: false, error: String(msg.error) });
        return;
      }
      case "set_default_selection":
        if (isSelection(msg.selection)) this.setDefaultSelection(msg.selection);
        return;
      case "set_recording":
        this.updateSettings({ recording: Boolean(msg.recording) });
        return;
      case "pong":
        return;
    }
  }

  private pingExtension() {
    const ws = this.extension as (WebSocket & { _bridgeAlive?: () => boolean }) | null;
    if (!ws) return;
    // App-level ping: keeps the extension's service worker awake.
    this.sendToExtension({ type: "ping" });
    ws.ping();
  }

  private sendToExtension(msg: DaemonMessage) {
    if (this.extension && this.extension.readyState === this.extension.OPEN) {
      this.extension.send(JSON.stringify(msg));
    }
  }

  private updateTargets(targets: Target[]) {
    const previous = this.targets;
    this.targets = targets;
    const summary = safeJson(
      targets.map((t) => [t.tabId, t.origin, t.tools.map((tool) => tool.name)]),
    );
    if (summary !== this.targetsSummary) {
      this.targetsSummary = summary;
      this.log.add({
        kind: "targets",
        status: "info",
        title: describeTargetChange(previous, targets),
        detail: targets.map((t) => ({
          tabId: t.tabId,
          origin: t.origin,
          title: t.title,
          generation: t.generation,
          tools: t.tools.map((tool) => tool.name),
        })),
      });
    }
    for (const session of this.sessions.values()) this.scheduleListChanged(session);
    this.pushState();
  }

  /** Runs a tool in a tab; the extension checks the tab still shows `origin`. */
  private async callTab(
    target: Target,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (!this.extension) {
      await waitFor(() => this.extension !== null, EXTENSION_WAIT_MS);
    }
    if (!this.extension) {
      return { ok: false, error: "The browser extension is not connected. Is Chrome running with Haven Agent Bridge?" };
    }
    const callId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        resolve({ ok: false, error: `The tab did not answer within ${Math.round(this.settings.callTimeoutMs / 1000)} s.` });
      }, this.settings.callTimeoutMs);
      this.pending.set(callId, { tabId: target.tabId, resolve, timer });
      this.sendToExtension({ type: "call", callId, tabId: target.tabId, origin: target.origin, name, args });
    });
  }

  // --- selection and settings ---

  private selectionOf(session: Session | null): Selection {
    return session?.selection ?? this.settings.defaultSelection;
  }

  private targetOf(session: Session | null): Target | null {
    return resolveTarget(this.targets, this.selectionOf(session));
  }

  setDefaultSelection(selection: Selection) {
    if (sameSelection(selection, this.settings.defaultSelection)) return;
    this.updateSettings({ defaultSelection: selection });
    this.log.add({ kind: "note", status: "info", title: `default target: ${describeSelection(selection)}` });
  }

  updateSettings(patch: Partial<BridgeSettings>) {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    for (const session of this.sessions.values()) this.scheduleListChanged(session);
    this.pushState();
  }

  private stateMessage(): DaemonMessage {
    return {
      type: "state",
      defaultSelection: this.settings.defaultSelection,
      resolvedTabId: this.targetOf(null)?.tabId ?? null,
      recording: this.settings.recording,
      sessions: this.sessions.size,
      uiUrl: this.uiUrl(),
    };
  }

  private pushState() {
    this.sendToExtension(this.stateMessage());
    this.broadcastGui("state", this.snapshot());
  }

  // --- MCP ---

  private async handleMcp(req: IncomingMessage, res: ServerResponse) {
    this.lastActivityAt = Date.now();
    const sessionHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader;
    const body = req.method === "POST" ? await readJson(req) : undefined;

    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        return sendJson(res, 404, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found (the bridge restarted?)" },
          id: null,
        });
      }
      session.lastSeenAt = Date.now();
      return session.transport.handleRequest(req, res, body);
    }
    if (req.method === "POST" && isInitializeRequest(body)) {
      const session = this.createSession();
      return session.transport.handleRequest(req, res, body);
    }
    return sendJson(res, 400, {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Send initialize first, or pass Mcp-Session-Id" },
      id: null,
    });
  }

  private createSession(): Session {
    const server = new Server(
      { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      { capabilities: { tools: { listChanged: true } }, instructions: SERVER_INSTRUCTIONS },
    );
    const session: Session = {
      id: "",
      server,
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          session.id = id;
          this.sessions.set(id, session);
        },
        onsessionclosed: (id) => this.dropSession(id),
      }),
      selection: null,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    server.oninitialized = () => {
      this.log.add({
        kind: "session",
        status: "info",
        title: `client connected: ${this.clientName(session)}`,
        sessionId: session.id,
        client: this.clientName(session),
      });
      this.pushState();
    };
    session.transport.onclose = () => {
      if (session.id) this.dropSession(session.id);
    };

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const target = this.targetOf(session);
      const tools = this.toolsFor(target);
      session.lastListedSignature = toolsSignature(target, this.metaToolNames());
      this.log.add({
        kind: "tools_list",
        status: "info",
        title: `tools/list → ${tools.length} tools${target ? ` from ${target.origin}` : " (no tab selected)"}`,
        sessionId: session.id,
        client: this.clientName(session),
        ...(target ? { origin: target.origin, tabId: target.tabId } : {}),
        detail: tools.map((t) => t.name),
      });
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      session.lastSeenAt = Date.now();
      const name = request.params.name;
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      return this.runTool(session, name, args);
    });

    void server.connect(session.transport);
    return session;
  }

  private dropSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) return;
    clearTimeout(session.notifyTimer);
    this.sessions.delete(id);
    this.log.add({
      kind: "session",
      status: "info",
      title: `client disconnected: ${this.clientName(session)}`,
      sessionId: id,
      client: this.clientName(session),
    });
    this.pushState();
  }

  private clientName(session: Session): string {
    const info = session.server.getClientVersion();
    return info ? `${info.name} ${info.version}` : "unknown client";
  }

  private metaToolNames(): string[] {
    return this.settings.fallbackTools
      ? [META_STATUS, META_TARGETS, META_TOOLS, META_CALL]
      : [META_STATUS, META_TARGETS];
  }

  private metaTools(): McpTool[] {
    const tools: McpTool[] = [
      {
        name: META_STATUS,
        description:
          "Shows whether the browser is connected and which tab (origin, title, tool count) this client's tools come from. The user picks the tab in the extension or the debug GUI.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: META_TARGETS,
        description: "Lists every allowed browser tab with its origin, title and the names of its tools, and marks the one this client is connected to.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
    ];
    if (this.settings.fallbackTools) {
      tools.push(
        {
          name: META_TOOLS,
          description:
            "Lists the tools of the connected tab with their input schemas. For clients that do not refresh their tool list when the tab changes; use bridge_tool_call to run one.",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true },
        },
        {
          name: META_CALL,
          description: "Runs a tool of the connected tab by name (see bridge_tools_list).",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "Tool name from bridge_tools_list" },
              arguments: { type: "object", description: "Input matching the tool's schema" },
            },
            required: ["name"],
          },
        },
      );
    }
    return tools;
  }

  private toolsFor(target: Target | null): McpTool[] {
    const meta = this.metaTools();
    const reserved = new Set(meta.map((t) => t.name));
    const pageTools = (target?.tools ?? [])
      .filter((t) => !reserved.has(t.name))
      .map((t) => toMcpTool(t, target!.origin));
    return [...meta, ...pageTools];
  }

  private scheduleListChanged(session: Session) {
    if (session.lastListedSignature === undefined) return;
    clearTimeout(session.notifyTimer);
    session.notifyTimer = setTimeout(() => {
      const target = this.targetOf(session);
      const signature = toolsSignature(target, this.metaToolNames());
      if (signature === session.lastListedSignature || signature === session.lastNotifiedSignature) return;
      session.lastNotifiedSignature = signature;
      session.server.sendToolListChanged().catch(() => {});
      this.log.add({
        kind: "list_changed",
        status: "info",
        title: `tools/list_changed → ${target ? `${target.tools.length} tools on ${target.origin}` : "no tab"}`,
        sessionId: session.id,
        client: this.clientName(session),
        ...(target ? { origin: target.origin, tabId: target.tabId } : {}),
      });
    }, LIST_CHANGED_DEBOUNCE_MS);
  }

  /** One tool call from an MCP client (or the GUI, with `session` null). */
  async runTool(
    session: Session | null,
    name: string,
    args: Record<string, unknown>,
    explicitTarget?: Target,
  ): Promise<ReturnType<typeof toCallResult> | ReturnType<typeof toErrorResult>> {
    const client = session ? this.clientName(session) : GUI_CLIENT;
    const target = explicitTarget ?? this.targetOf(session);

    if (!explicitTarget && this.metaToolNames().includes(name)) {
      return this.runMetaTool(session, name, args, target);
    }
    if (!target) {
      return toErrorResult(
        this.targets.length === 0
          ? "No allowed browser tab has WebMCP tools. Open Haven in Chrome (with the Haven Agent Bridge extension) and allow its origin."
          : `No tab matches the selection (${describeSelection(this.selectionOf(session))}). Ask the user to pick a tab in the extension.`,
      );
    }
    if (!target.tools.some((t) => t.name === name)) {
      const elsewhere = this.targets.filter((t) => t !== target && t.tools.some((tool) => tool.name === name));
      return toErrorResult(
        `Tool "${name}" is not offered by the connected tab (${target.origin}).` +
          (elsewhere.length
            ? ` It exists in ${elsewhere.map((t) => t.origin).join(", ")}; the user can switch tabs in the extension.`
            : " Call tools/list again; the page may have changed its tools."),
      );
    }

    const finish = this.log.startCall({
      sessionId: session?.id,
      client,
      origin: target.origin,
      tabId: target.tabId,
      tool: name,
      args,
    });
    const outcome = await this.callTab(target, name, args);
    const result = outcome.ok ? toCallResult(outcome.result) : toErrorResult(outcome.error);
    const bytes = Buffer.byteLength(safeJson(result));
    if (outcome.ok && !("isError" in result && result.isError)) {
      finish({ ok: true, result: outcome.result, bytes });
    } else {
      finish({ ok: false, error: outcome.ok ? safeJson(outcome.result) : outcome.error, bytes });
    }
    return result;
  }

  private async runMetaTool(
    session: Session | null,
    name: string,
    args: Record<string, unknown>,
    target: Target | null,
  ) {
    const summary = (t: Target) => ({
      origin: t.origin,
      title: t.title,
      url: t.url,
      tools: t.tools.length,
      connected: t === target,
    });
    switch (name) {
      case META_STATUS:
        return toCallResult({
          browserConnected: this.extension !== null,
          selection: describeSelection(this.selectionOf(session)),
          connectedTab: target ? summary(target) : null,
          otherTabs: this.targets.filter((t) => t !== target).map(summary),
          note: "The user chooses the tab in the Haven Agent Bridge extension popup or debug GUI.",
        });
      case META_TARGETS:
        return toCallResult({
          tabs: this.targets.map((t) => ({ ...summary(t), toolNames: t.tools.map((tool) => tool.name) })),
        });
      case META_TOOLS:
        return toCallResult({
          tab: target ? summary(target) : null,
          tools: target ? target.tools.map((t) => toMcpTool(t, target.origin)) : [],
        });
      case META_CALL: {
        const toolName = typeof args.name === "string" ? args.name : "";
        const toolArgs =
          typeof args.arguments === "object" && args.arguments !== null
            ? (args.arguments as Record<string, unknown>)
            : {};
        if (!toolName || this.metaToolNames().includes(toolName)) {
          return toErrorResult('Pass "name" of a tool from bridge_tools_list.');
        }
        return this.runTool(session, toolName, toolArgs);
      }
    }
    return toErrorResult(`Unknown tool ${name}`);
  }

  // --- GUI API ---

  snapshot() {
    const defaultTarget = this.targetOf(null);
    return {
      version: BRIDGE_VERSION,
      port: this.port,
      extension: this.extension
        ? { connected: true, ...(this.extensionInfo ?? { version: "?", origins: [] }) }
        : { connected: false },
      settings: this.settings,
      defaultTabId: defaultTarget?.tabId ?? null,
      targets: this.targets,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        client: this.clientName(s),
        selection: s.selection,
        tabId: this.targetOf(s)?.tabId ?? null,
        createdAt: s.createdAt,
        lastSeenAt: s.lastSeenAt,
      })),
      pendingCalls: this.pending.size,
    };
  }

  private async handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "GET" && path === "/api/state") return sendJson(res, 200, this.snapshot());
    if (method === "GET" && path === "/api/log") {
      return sendJson(res, 200, this.log.list(Number(url.searchParams.get("since") ?? 0)));
    }
    if (method === "GET" && path === "/api/stats") return sendJson(res, 200, this.log.stats());
    if (method === "GET" && path === "/api/events") return this.openEventStream(req, res);
    if (method === "GET" && path === "/api/export") return this.exportLog(res, url);

    if (method !== "POST") return sendJson(res, 404, { error: "Not found" });
    const body = ((await readJson(req)) ?? {}) as Record<string, unknown>;

    if (path === "/api/settings") {
      const patch: Partial<BridgeSettings> = {};
      if (typeof body.recording === "boolean") patch.recording = body.recording;
      if (typeof body.fallbackTools === "boolean") patch.fallbackTools = body.fallbackTools;
      if (typeof body.logFile === "boolean") patch.logFile = body.logFile;
      if (typeof body.logLimit === "number" && body.logLimit >= 100) patch.logLimit = Math.floor(body.logLimit);
      if (typeof body.callTimeoutMs === "number" && body.callTimeoutMs >= 1000) {
        patch.callTimeoutMs = Math.floor(body.callTimeoutMs);
      }
      if (isSelection(body.defaultSelection)) this.setDefaultSelection(body.defaultSelection);
      this.updateSettings(patch);
      return sendJson(res, 200, this.snapshot());
    }
    const selectionMatch = /^\/api\/sessions\/([^/]+)\/selection$/.exec(path);
    if (selectionMatch) {
      const session = this.sessions.get(decodeURIComponent(selectionMatch[1]!));
      if (!session) return sendJson(res, 404, { error: "No such session" });
      const selection = body.selection === null ? null : isSelection(body.selection) ? body.selection : undefined;
      if (selection === undefined) return sendJson(res, 400, { error: "selection must be a selection or null" });
      session.selection = selection;
      this.log.add({
        kind: "note",
        status: "info",
        title: `${this.clientName(session)} now uses ${selection ? describeSelection(selection) : "the default target"}`,
        sessionId: session.id,
        client: this.clientName(session),
      });
      this.scheduleListChanged(session);
      this.pushState();
      return sendJson(res, 200, this.snapshot());
    }
    if (path === "/api/call") {
      const target = this.targets.find((t) => t.tabId === body.tabId);
      if (!target || typeof body.name !== "string") {
        return sendJson(res, 400, { error: "Pass tabId of a known tab and the tool name" });
      }
      const args = typeof body.args === "object" && body.args !== null ? (body.args as Record<string, unknown>) : {};
      return sendJson(res, 200, await this.runTool(null, body.name, args, target));
    }
    if (path === "/api/clear") {
      this.log.clear();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: "Not found" });
  }

  private openEventStream(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    res.write(`event: state\ndata: ${safeJson(this.snapshot())}\n\n`);
    this.guiStreams.add(res);
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      this.guiStreams.delete(res);
    });
  }

  private broadcastGui(event: string, data: unknown) {
    if (this.guiStreams.size === 0) return;
    const chunk = `event: ${event}\ndata: ${safeJson(data)}\n\n`;
    for (const res of this.guiStreams) res.write(chunk);
  }

  private exportLog(res: ServerResponse, url: URL) {
    const redact = url.searchParams.get("redact") === "1";
    const format = url.searchParams.get("format") === "ndjson" ? "ndjson" : "json";
    const kinds = url.searchParams.get("kinds")?.split(",").filter(Boolean);
    const entries: LogEntry[] = this.log
      .list()
      .filter((e) => !kinds || kinds.includes(e.kind))
      .map((e) => (redact ? redactEntry(e) : e));
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    if (format === "ndjson") {
      res.writeHead(200, {
        "content-type": "application/x-ndjson",
        "content-disposition": `attachment; filename="haven-agent-bridge-${stamp}.ndjson"`,
      });
      res.end(entries.map((e) => safeJson(e)).join("\n") + "\n");
      return;
    }
    const snapshot = this.snapshot();
    res.writeHead(200, {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="haven-agent-bridge-${stamp}.json"`,
    });
    res.end(
      JSON.stringify(
        {
          exportedAt: new Date().toISOString(),
          bridgeVersion: BRIDGE_VERSION,
          redacted: redact,
          targets: snapshot.targets,
          sessions: snapshot.sessions,
          stats: this.log.stats(),
          entries,
        },
        null,
        2,
      ),
    );
  }
}

function describeTargetChange(before: Target[], after: Target[]): string {
  const parts: string[] = [];
  for (const t of after) {
    const old = before.find((b) => b.tabId === t.tabId);
    if (!old || old.origin !== t.origin) {
      parts.push(`+ tab ${t.tabId} ${t.origin} (${t.tools.length} tools)`);
      continue;
    }
    const oldNames = new Set(old.tools.map((x) => x.name));
    const newNames = new Set(t.tools.map((x) => x.name));
    const added = [...newNames].filter((n) => !oldNames.has(n));
    const removed = [...oldNames].filter((n) => !newNames.has(n));
    if (added.length || removed.length) {
      parts.push(
        `tab ${t.tabId} ${t.origin}: ${added.length ? `+${added.length}` : ""}${added.length && removed.length ? " " : ""}${removed.length ? `−${removed.length}` : ""} tools (now ${t.tools.length})`,
      );
    }
  }
  for (const b of before) {
    if (!after.some((t) => t.tabId === b.tabId && t.origin === b.origin)) {
      parts.push(`− tab ${b.tabId} ${b.origin}`);
    }
  }
  return parts.length ? parts.join("; ") : "tabs updated";
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      if (condition() || Date.now() > deadline) {
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sendFile(res: ServerResponse, name: string, type: string) {
  try {
    const content = readFileSync(join(PACKAGE_ROOT, "ui", name));
    res.writeHead(200, {
      "content-type": type,
      "cache-control": "no-store",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
    });
    res.end(content);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
