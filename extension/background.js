// Service worker: keeps the list of allowed tabs and their WebMCP tools, sends
// it to the bridge daemon on 127.0.0.1 and runs the daemon's calls in the tab
// they were meant for. A call names the tab and the origin it expects; if the
// tab shows another origin by now, the call fails instead of running there.

import "./i18n.js";

const { msg, plural } = globalThis.habI18n;
const PROTOCOL = 1;
const PORT_FIRST = 13300;
const PORT_LAST = 13309;
const DEFAULT_ORIGINS = [
  "http://localhost:4174",
  "https://haven.mindoodb.com",
  "https://mindoodb-haven-develop.pages.dev",
];
const SCRIPT_IDS = ["hab-isolated", "hab-main"];
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;

/** tabId -> target (see src/protocol.ts `Target`) */
const targets = new Map();
let origins = [...DEFAULT_ORIGINS];
let ws = null;
let connectedPort = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let connecting = false;
/** Last `state` message from the daemon. */
let daemonState = null;
const popups = new Set();
const ready = init();

// --- startup ---

async function init() {
  const stored = await chrome.storage.local.get("origins");
  if (Array.isArray(stored.origins)) origins = stored.origins;
  const session = await chrome.storage.session.get("targets").catch(() => ({}));
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const t of session.targets || []) {
    if (open.has(t.tabId)) targets.set(t.tabId, t);
  }
  await syncContentScripts();
  chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
  connect();
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostPattern(origin) {
  const url = new URL(origin);
  // Match patterns ignore ports; the origin check below is exact.
  return `${url.protocol}//${url.hostname}/*`;
}

let syncChain = Promise.resolve();

/** Registers the content scripts for every allowed origin we hold a permission for. */
function syncContentScripts() {
  // Calls overlap at startup; registering twice fails with "Duplicate script ID".
  syncChain = syncChain.catch(() => {}).then(registerContentScripts);
  return syncChain;
}

async function registerContentScripts() {
  const matches = [];
  for (const origin of origins) {
    const pattern = hostPattern(origin);
    if (!matches.includes(pattern) && (await chrome.permissions.contains({ origins: [pattern] }))) {
      matches.push(pattern);
    }
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
  if (!matches.length) return;
  await chrome.scripting.registerContentScripts([
    { id: "hab-isolated", matches, js: ["content-isolated.js"], runAt: "document_start", world: "ISOLATED", persistAcrossSessions: true },
    { id: "hab-main", matches, js: ["content-main.js"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
  ]);
}

async function setOrigins(next) {
  await ready;
  origins = [...new Set(next.map((o) => originOf(o)).filter(Boolean))];
  await chrome.storage.local.set({ origins });
  await syncContentScripts();
  for (const [tabId, t] of targets) {
    if (!origins.includes(t.origin)) targets.delete(tabId);
  }
  send({ type: "hello", protocol: PROTOCOL, extensionVersion: chrome.runtime.getManifest().version, origins });
  targetsChanged();
}

// --- tab state ---

let saveTimer = null;
let sendTimer = null;

function targetsChanged() {
  clearTimeout(sendTimer);
  sendTimer = setTimeout(() => {
    send({ type: "targets", targets: snapshot() });
    updateBadge();
    notifyPopups();
  }, 50);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.session.set({ targets: [...targets.values()] }).catch(() => {}), 300);
}

function snapshot() {
  return [...targets.values()];
}

function touch(tabId) {
  const t = targets.get(tabId);
  if (!t) return;
  t.lastActiveAt = Date.now();
  targetsChanged();
}

chrome.tabs.onActivated.addListener(({ tabId }) => touch(tabId));

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab) touch(tab.id);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (targets.delete(tabId)) {
    failPending(tabId, "The tab was closed before it answered; the call may or may not have run.");
    targetsChanged();
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  const t = targets.get(tabId);
  if (!t) return;
  if (change.url && originOf(change.url) !== t.origin) {
    // Navigated away; the next page announces itself if its origin is allowed.
    targets.delete(tabId);
    failPending(tabId, "The tab navigated away before it answered; the call may or may not have run.");
    targetsChanged();
    return;
  }
  if (change.url || change.title) {
    if (change.url) t.url = change.url;
    if (change.title) t.title = change.title;
    targetsChanged();
  }
});

// --- messages from content scripts and the popup ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.tab) {
    ready.then(() => onPageMessage(message, sender));
    return false;
  }
  if (message && message.type === "popup:set-origins") {
    ready
      .then(() => setOrigins(message.origins))
      .then(() => sendResponse({ ok: true }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  return false;
});

function onPageMessage(message, sender) {
  const tab = sender.tab;
  const origin = sender.origin || originOf(sender.url);
  if (sender.frameId !== 0 || !origin || !origins.includes(origin)) return;

  if (message.type === "tools") {
    const previous = targets.get(tab.id);
    const sameDocument = previous && previous.documentId === sender.documentId;
    targets.set(tab.id, {
      tabId: tab.id,
      windowId: tab.windowId,
      origin,
      url: tab.url || sender.url,
      title: tab.title || "",
      generation: (previous ? previous.generation : 0) + 1,
      lastActiveAt: previous && previous.origin === origin ? previous.lastActiveAt : tab.active ? Date.now() : 0,
      native: Boolean(message.native),
      tools: sanitizeTools(message.tools),
      documentId: sender.documentId,
    });
    if (previous && !sameDocument) failPending(tab.id, "The page reloaded before it answered; the call may or may not have run.");
    targetsChanged();
  } else if (message.type === "tool-result") {
    pending.delete(message.callId);
    send(
      message.ok
        ? { type: "tool_result", callId: message.callId, ok: true, result: message.result }
        : { type: "tool_result", callId: message.callId, ok: false, error: String(message.error) },
    );
  } else if (message.type === "page-gone") {
    const t = targets.get(tab.id);
    if (t && t.documentId === sender.documentId) {
      targets.delete(tab.id);
      failPending(tab.id, "The page was closed or reloaded before it answered; the call may or may not have run.");
      targetsChanged();
    }
  }
}

function sanitizeTools(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    if (!t || typeof t.name !== "string" || seen.has(t.name)) continue;
    seen.add(t.name);
    out.push({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
      ...(t.annotations && typeof t.annotations === "object" ? { annotations: t.annotations } : {}),
    });
  }
  return out;
}

// --- calls ---

/** callId -> tabId */
const pending = new Map();

function failPending(tabId, error) {
  for (const [callId, callTab] of pending) {
    if (callTab !== tabId) continue;
    pending.delete(callId);
    send({ type: "tool_result", callId, ok: false, error, fromBridge: true });
  }
}

async function runCall(msg) {
  await ready;
  const t = targets.get(msg.tabId);
  const fail = (error) => send({ type: "tool_result", callId: msg.callId, ok: false, error, fromBridge: true });
  if (!t) return fail("The tab is gone (closed or navigated away); the call was not run.");
  if (t.origin !== msg.origin) return fail(`The tab now shows ${t.origin}, not ${msg.origin}; the call was not run.`);
  if (msg.documentId && t.documentId !== msg.documentId) {
    return fail("The page in the tab was reloaded since the tools were listed; the call was not run.");
  }
  if (!t.tools.some((tool) => tool.name === msg.name)) return fail(`The tab has no tool "${msg.name}" (any more); the call was not run.`);
  pending.set(msg.callId, t.tabId);
  try {
    await chrome.tabs.sendMessage(
      t.tabId,
      { type: "execute-tool", callId: msg.callId, name: msg.name, args: msg.args || {} },
      t.documentId ? { documentId: t.documentId } : { frameId: 0 },
    );
  } catch (error) {
    if (pending.delete(msg.callId)) fail(`Could not reach the tab, the call was not run: ${error && error.message ? error.message : error}`);
  }
}

// --- connection to the daemon ---

function send(message) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

async function connect() {
  if (connecting || (ws && ws.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  try {
    for (let port = PORT_FIRST; port <= PORT_LAST; port++) {
      let info;
      try {
        const res = await fetch(`http://127.0.0.1:${port}/.well-known/haven-agent-bridge`, {
          signal: AbortSignal.timeout(1000),
        });
        if (!res.ok) continue;
        info = await res.json();
      } catch {
        continue;
      }
      if (info && info.name === "haven-agent-bridge" && info.token) {
        open(port, info.token);
        return;
      }
    }
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

function open(port, token) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ext?token=${encodeURIComponent(token)}`);
  ws = socket;
  socket.onopen = async () => {
    await ready;
    connectedPort = port;
    reconnectDelay = RECONNECT_MIN_MS;
    send({ type: "hello", protocol: PROTOCOL, extensionVersion: chrome.runtime.getManifest().version, origins });
    send({ type: "targets", targets: snapshot() });
    // After a service-worker restart the cached tools may be stale.
    for (const tabId of targets.keys()) {
      chrome.tabs.sendMessage(tabId, { type: "re-announce" }).catch(() => {});
    }
    updateBadge();
    notifyPopups();
  };
  socket.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "call") runCall(msg);
    else if (msg.type === "ping") send({ type: "pong" });
    else if (msg.type === "state") {
      daemonState = msg;
      updateBadge();
      notifyPopups();
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    connectedPort = null;
    daemonState = null;
    for (const callId of pending.keys()) pending.delete(callId);
    updateBadge();
    notifyPopups();
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && (!ws || ws.readyState !== WebSocket.OPEN)) {
    reconnectDelay = RECONNECT_MIN_MS;
    connect();
  }
});

// --- badge and popup ---

function updateBadge() {
  const connected = ws && ws.readyState === WebSocket.OPEN;
  const target = daemonState && daemonState.resolvedTabId != null ? targets.get(daemonState.resolvedTabId) : null;
  chrome.action.setBadgeBackgroundColor({ color: connected ? (target ? "#16a34a" : "#ca8a04") : "#6b7280" });
  chrome.action.setBadgeText({ text: connected ? (target ? String(target.tools.length) : "–") : "" });
  chrome.action.setTitle({
    title: connected
      ? target
        ? msg("badgeTools", plural("toolsCount", target.tools.length), target.origin)
        : msg("badgeNoTab")
      : msg("badgeNotRunning"),
  });
}

async function popupStatus() {
  const allowedTabs = (await chrome.tabs.query({})).filter((t) => origins.includes(originOf(t.url || "")));
  return {
    type: "status",
    connected: Boolean(ws && ws.readyState === WebSocket.OPEN),
    port: connectedPort,
    daemon: daemonState,
    origins,
    defaultOrigins: DEFAULT_ORIGINS,
    targets: snapshot(),
    // Allowed tabs that did not announce: opened before the extension, need a reload.
    silentTabs: allowedTabs
      .filter((t) => !targets.has(t.id))
      .map((t) => ({ tabId: t.id, origin: originOf(t.url), title: t.title || "" })),
  };
}

async function notifyPopups() {
  if (!popups.size) return;
  const status = await popupStatus();
  for (const port of popups) port.postMessage(status);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "popup") return;
  popups.add(port);
  port.onDisconnect.addListener(() => popups.delete(port));
  port.onMessage.addListener(async (msg) => {
    await ready;
    if (msg.type === "status") port.postMessage(await popupStatus());
    else if (msg.type === "select") send({ type: "set_default_selection", selection: msg.selection });
    else if (msg.type === "recording") send({ type: "set_recording", recording: Boolean(msg.recording) });
    else if (msg.type === "reload-tab") chrome.tabs.reload(msg.tabId);
    else if (msg.type === "reconnect") {
      reconnectDelay = RECONNECT_MIN_MS;
      connect();
    }
  });
});

// For tests and debugging from the service worker console.
globalThis.havenAgentBridge = {
  setOrigins,
  status: popupStatus,
  targets: () => snapshot(),
};
