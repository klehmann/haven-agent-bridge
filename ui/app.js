// Debug GUI of the Haven Agent Bridge. Everything shown comes from web pages
// and MCP clients, so it is always set as text, never as HTML.
"use strict";

const TOKEN_KEY = "haven-agent-bridge-token";
const token = (() => {
  const match = /token=([0-9a-f]{64})/.exec(location.hash);
  if (match) {
    try {
      sessionStorage.setItem(TOKEN_KEY, match[1]);
    } catch {
      // Storage blocked: the token lives as long as this page.
    }
    history.replaceState(null, "", location.pathname);
    return match[1];
  }
  try {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
})();

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("aria-")) node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { "x-bridge-token": token, "content-type": "application/json", ...(options.headers || {}) },
  });
  if (res.status === 401) throw new Error("Wrong or missing token: open the GUI from the extension or `haven-agent-bridge ui`.");
  return res;
}

const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

// --- state ---

let state = null;
const entries = new Map(); // id -> entry
const expanded = new Set();
let view = "calls";

function time(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return time(ms);
}
function size(bytes) {
  if (bytes === undefined) return "";
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
function pretty(value) {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}
function tabLabel(tabId) {
  const t = state && state.targets.find((x) => x.tabId === tabId);
  return t ? `${t.origin} #${tabId}` : tabId === undefined ? "" : `#${tabId}`;
}

// --- header ---

function renderHeader() {
  const chip = $("status");
  if (!state) return;
  const ext = state.extension;
  chip.textContent = ext.connected
    ? `browser connected · port ${state.port} · ${state.sessions.length} client(s) · v${state.version}`
    : `browser not connected · port ${state.port} · v${state.version}`;
  chip.className = `chip ${ext.connected ? "ok" : "err"}`;
  $("recording").checked = state.settings.recording;
  $("fallback").checked = state.settings.fallbackTools;
  $("recording-hint").hidden = state.settings.recording;
}

$("recording").addEventListener("change", (e) => post("/api/settings", { recording: e.target.checked }));
$("fallback").addEventListener("change", (e) => post("/api/settings", { fallbackTools: e.target.checked }));
$("clear").addEventListener("click", async () => {
  if (!confirm("Clear the log and the statistics?")) return;
  await post("/api/clear", {});
  entries.clear();
  expanded.clear();
  await loadLog();
  renderLog();
  refreshStats();
});

async function download(format) {
  const redact = $("redact").checked ? "1" : "0";
  const res = await api(`/api/export?format=${format}&redact=${redact}`);
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") || "")?.[1] || `export.${format}`;
  const a = el("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
$("export-json").addEventListener("click", () => download("json"));
$("export-ndjson").addEventListener("click", () => download("ndjson"));

// --- views ---

for (const button of document.querySelectorAll(".tabs button")) {
  button.addEventListener("click", () => {
    view = button.dataset.view;
    for (const b of document.querySelectorAll(".tabs button")) b.setAttribute("aria-selected", String(b === button));
    for (const section of document.querySelectorAll(".view")) section.hidden = section.id !== `view-${view}`;
    render();
  });
}

function render() {
  renderHeader();
  if (view === "calls") renderLog();
  if (view === "tools") renderTools();
  if (view === "targets") renderTargets();
  if (view === "stats") refreshStats();
}

// --- calls ---

let renderQueued = false;
function queueLog() {
  if (renderQueued || view !== "calls") return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderLog();
  });
}

for (const id of ["filter", "show-events", "errors-only"]) $(id).addEventListener("input", renderLog);

function matches(entry, query) {
  if (!query) return true;
  const hay = [entry.title, entry.client, entry.origin, entry.tool, entry.error, entry.args, entry.result, entry.detail]
    .map((v) => (v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v)))
    .join("\n")
    .toLowerCase();
  return hay.includes(query);
}

function renderLog() {
  const query = $("filter").value.trim().toLowerCase();
  const showEvents = $("show-events").checked;
  const errorsOnly = $("errors-only").checked;
  const list = [...entries.values()]
    .filter((e) => (showEvents || e.kind === "call") && (!errorsOnly || e.status === "error") && matches(e, query))
    .sort((a, b) => b.id - a.id)
    .slice(0, 500);
  $("log-count").textContent = `${list.length} of ${entries.size} entries`;
  const body = $("log-body");
  body.replaceChildren();
  for (const e of list) {
    const row = el(
      "tr",
      { class: "row", tabIndex: 0, "aria-expanded": String(expanded.has(e.id)) },
      el("td", { textContent: time(e.at) }),
      el("td", { class: "kind", textContent: e.kind }),
      el("td", { class: "what", textContent: e.kind === "call" ? e.tool : e.title }),
      el("td", { textContent: e.client || "" }),
      el("td", { textContent: e.origin ? `${e.origin}${e.tabId !== undefined ? ` #${e.tabId}` : ""}` : "" }),
      el("td", { class: `status-${e.status}`, textContent: e.status }),
      el("td", { class: "num", textContent: e.durationMs !== undefined ? String(e.durationMs) : "" }),
      el("td", { class: "num", textContent: size(e.bytes) }),
    );
    const toggle = () => {
      if (expanded.has(e.id)) expanded.delete(e.id);
      else expanded.add(e.id);
      renderLog();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggle();
      }
    });
    body.append(row);
    if (expanded.has(e.id)) body.append(detailRow(e));
  }
}

function block(label, value) {
  return el("div", {}, el("strong", { textContent: label }), el("pre", { textContent: pretty(value) }));
}

function detailRow(e) {
  const parts = [];
  if (e.kind === "call") {
    if (e.payloadOmitted) parts.push(el("p", { class: "muted", textContent: "Arguments and response were not recorded (recording was off)." }));
    if (e.args !== undefined) parts.push(block("Arguments", e.args));
    if (e.result !== undefined) parts.push(block("Response", e.result));
    if (e.error !== undefined) parts.push(block("Error", e.error));
  }
  if (e.detail !== undefined) parts.push(block("Detail", e.detail));
  const copy = el("button", { type: "button", textContent: "Copy entry as JSON" });
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(e, null, 2));
  });
  const meta = el("p", { class: "muted" }, `#${e.id} · ${new Date(e.at).toISOString()}${e.sessionId ? ` · session ${e.sessionId}` : ""} `, copy);
  return el("tr", { class: "detail" }, el("td", { colSpan: 8 }, meta, el("div", { class: "detail-grid" }, ...parts)));
}

// --- tools ---

$("tools-tab").addEventListener("change", renderToolList);
$("tools-filter").addEventListener("input", renderToolList);

function renderTools() {
  const select = $("tools-tab");
  const previous = select.value;
  select.replaceChildren();
  for (const t of state.targets) {
    select.append(
      el("option", {
        value: String(t.tabId),
        textContent: `${t.tabId === state.defaultTabId ? "● " : ""}${t.title || t.origin} — ${t.origin} (${t.tools.length})`,
      }),
    );
  }
  const keep = state.targets.some((t) => String(t.tabId) === previous);
  select.value = keep ? previous : state.defaultTabId !== null ? String(state.defaultTabId) : select.value;
  renderToolList();
}

function skeleton(schema) {
  const out = {};
  const props = (schema && schema.properties) || {};
  for (const name of schema && Array.isArray(schema.required) ? schema.required : []) {
    const p = props[name] || {};
    out[name] =
      p.default !== undefined ? p.default : Array.isArray(p.enum) ? p.enum[0] : p.type === "number" || p.type === "integer" ? 0 : p.type === "boolean" ? false : p.type === "array" ? [] : p.type === "object" ? {} : "";
  }
  return out;
}

function renderToolList() {
  const target = state.targets.find((t) => String(t.tabId) === $("tools-tab").value);
  const box = $("tools-list");
  box.replaceChildren();
  if (!target) {
    box.append(el("p", { class: "muted", textContent: "No allowed tab with tools." }));
    $("tools-count").textContent = "";
    return;
  }
  const query = $("tools-filter").value.trim().toLowerCase();
  const tools = target.tools.filter((t) => !query || `${t.name}\n${t.description}`.toLowerCase().includes(query));
  $("tools-count").textContent = `${tools.length} of ${target.tools.length} tools · registration #${target.generation}`;
  for (const tool of tools) {
    const a = tool.annotations || {};
    const head = el(
      "div",
      { class: "tool-head" },
      el("span", { class: "tool-name", textContent: tool.name }),
      a.readOnlyHint ? el("span", { class: "badge ro", textContent: "read-only" }) : null,
      a.consequentialHint ? el("span", { class: "badge cq", textContent: "consequential" }) : null,
      a.untrustedContentHint ? el("span", { class: "badge ut", textContent: "untrusted content" }) : null,
    );
    const schema = el("details", {}, el("summary", { textContent: "Input schema" }), el("pre", { textContent: pretty(tool.inputSchema) }));
    const input = el("textarea", { value: JSON.stringify(skeleton(tool.inputSchema), null, 2), spellcheck: false, "aria-label": `Input for ${tool.name}` });
    const output = el("pre", { hidden: true });
    const run = el("button", { type: "button", textContent: "Run in this tab" });
    const note = el("span", { class: "muted" });
    run.addEventListener("click", async () => {
      let args;
      try {
        args = JSON.parse(input.value || "{}");
      } catch (error) {
        note.textContent = `Invalid JSON: ${error.message}`;
        return;
      }
      if (a.consequentialHint && !confirm(`${tool.name} changes data. Run it?`)) return;
      run.disabled = true;
      note.textContent = "running…";
      const started = performance.now();
      try {
        const result = await post("/api/call", { tabId: target.tabId, name: tool.name, args });
        note.textContent = `${result.isError ? "error" : "ok"} · ${Math.round(performance.now() - started)} ms`;
        output.textContent = pretty(result);
        output.hidden = false;
      } catch (error) {
        note.textContent = String(error);
      } finally {
        run.disabled = false;
      }
    });
    const tryBox = el("details", { class: "try" }, el("summary", { textContent: "Try it" }), input, el("div", { class: "actions" }, run, note), output);
    box.append(el("div", { class: "tool" }, head, el("p", { class: "tool-desc", textContent: tool.description }), schema, tryBox));
  }
}

// --- tabs & clients ---

function selectionOptions(select, current, includeDefault) {
  select.replaceChildren();
  const add = (value, label) => select.append(el("option", { value, textContent: label }));
  if (includeDefault) add("default", "Default tab");
  add("active", "The allowed tab used last");
  const origins = [...new Set(state.targets.map((t) => t.origin))];
  for (const origin of origins) add(`origin:${origin}`, `Any tab on ${origin}`);
  for (const t of state.targets) add(`tab:${t.tabId}:${t.origin}`, `Tab #${t.tabId}: ${t.title || t.origin}`);
  const key = !current ? "default" : current.mode === "active" ? "active" : current.mode === "origin" ? `origin:${current.origin}` : `tab:${current.tabId}:${current.origin}`;
  if (![...select.options].some((o) => o.value === key)) add(key, `${key} (not open)`);
  select.value = key;
}

function parseSelection(value) {
  if (value === "default") return null;
  if (value === "active") return { mode: "active" };
  if (value.startsWith("origin:")) return { mode: "origin", origin: value.slice(7) };
  const [, tabId, ...origin] = value.split(":");
  return { mode: "tab", tabId: Number(tabId), origin: origin.join(":") };
}

$("default-selection").addEventListener("change", (e) => post("/api/settings", { defaultSelection: parseSelection(e.target.value) }));

function renderTargets() {
  selectionOptions($("default-selection"), state.settings.defaultSelection, false);
  const resolved = state.targets.find((t) => t.tabId === state.defaultTabId);
  $("default-resolved").textContent = resolved ? `→ ${resolved.title || resolved.origin} (${resolved.origin})` : "→ no matching tab";

  const body = $("targets-body");
  body.replaceChildren();
  for (const t of state.targets) {
    body.append(
      el(
        "tr",
        { class: t.tabId === state.defaultTabId ? "is-default" : "" },
        el("td", { textContent: `#${t.tabId}` }),
        el("td", { textContent: t.title }),
        el("td", { textContent: t.origin }),
        el("td", { class: "num", textContent: String(t.tools.length) }),
        el("td", { textContent: t.native ? "native" : "polyfill" }),
        el("td", { class: "num", textContent: String(t.generation) }),
        el("td", { textContent: ago(t.lastActiveAt) }),
      ),
    );
  }
  if (!state.targets.length) body.append(el("tr", {}, el("td", { colSpan: 7, class: "muted", textContent: "No allowed tab is open." })));

  const sessions = $("sessions-body");
  sessions.replaceChildren();
  for (const s of state.sessions) {
    const select = el("select", { "aria-label": `Tab for ${s.client}` });
    selectionOptions(select, s.selection, true);
    select.addEventListener("change", () => post(`/api/sessions/${encodeURIComponent(s.id)}/selection`, { selection: parseSelection(select.value) }));
    sessions.append(
      el(
        "tr",
        {},
        el("td", { textContent: s.client }),
        el("td", { textContent: ago(s.createdAt) }),
        el("td", { textContent: ago(s.lastSeenAt) }),
        el("td", {}, select),
        el("td", { textContent: s.tabId !== null ? tabLabel(s.tabId) : "no tab" }),
      ),
    );
  }
  if (!state.sessions.length) sessions.append(el("tr", {}, el("td", { colSpan: 5, class: "muted", textContent: "No MCP client connected." })));

  const ext = state.extension;
  $("extension-info").textContent = ext.connected
    ? `Extension ${ext.version} · allowed origins: ${(ext.origins || []).join(", ")}`
    : "The browser extension is not connected.";
}

// --- stats ---

let statsTimer = null;
async function refreshStats() {
  if (view !== "stats") return;
  clearTimeout(statsTimer);
  const stats = await (await api("/api/stats")).json();
  const totals = $("stats-totals");
  totals.replaceChildren(
    ...[
      ["Calls", stats.totals.calls],
      ["Errors", stats.totals.errors],
      ["Error rate", stats.totals.calls ? `${Math.round((100 * stats.totals.errors) / stats.totals.calls)} %` : "–"],
      ["tools/list", stats.totals.toolsLists],
      ["list_changed", stats.totals.listChanged],
      ["Since", time(stats.since)],
    ].map(([label, value]) => el("div", { class: "total" }, el("b", { textContent: String(value) }), label)),
  );
  const tools = $("stats-tools");
  tools.replaceChildren(
    ...stats.tools.map((s) =>
      el(
        "tr",
        {},
        el("td", { textContent: s.tool }),
        el("td", { textContent: s.origin }),
        el("td", { class: "num", textContent: String(s.calls) }),
        el("td", { class: "num", textContent: String(s.errors) }),
        el("td", { class: "num", textContent: `${Math.round(s.errorRate * 100)} %` }),
        el("td", { class: "num", textContent: String(s.avgMs) }),
        el("td", { class: "num", textContent: String(s.p50Ms) }),
        el("td", { class: "num", textContent: String(s.p95Ms) }),
        el("td", { class: "num", textContent: String(s.maxMs) }),
        el("td", { class: "num", textContent: size(s.avgBytes) }),
        el("td", { textContent: ago(s.lastAt) }),
      ),
    ),
  );
  if (!stats.tools.length) tools.append(el("tr", {}, el("td", { colSpan: 11, class: "muted", textContent: "No calls yet." })));
  const clients = $("stats-clients");
  clients.replaceChildren(
    ...stats.clients.map((s) =>
      el(
        "tr",
        {},
        el("td", { textContent: s.client }),
        el("td", { class: "num", textContent: String(s.calls) }),
        el("td", { class: "num", textContent: String(s.errors) }),
        el("td", { class: "num", textContent: String(s.avgMs) }),
        el("td", { textContent: ago(s.lastAt) }),
      ),
    ),
  );
  statsTimer = setTimeout(refreshStats, 3000);
}

// --- live updates ---

async function loadLog() {
  const list = await (await api("/api/log")).json();
  for (const e of list) entries.set(e.id, e);
}

function connectEvents() {
  const source = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  source.addEventListener("state", (event) => {
    state = JSON.parse(event.data);
    renderHeader();
    if (view === "tools") renderTools();
    if (view === "targets") renderTargets();
  });
  source.addEventListener("entry", (event) => {
    const entry = JSON.parse(event.data);
    entries.set(entry.id, entry);
    queueLog();
  });
  source.onerror = () => {
    $("status").textContent = "bridge not reachable — retrying…";
    $("status").className = "chip err";
  };
}

(async () => {
  if (!token) {
    $("status").textContent = "no token — open the GUI from the extension popup or `haven-agent-bridge ui`";
    $("status").className = "chip err";
    return;
  }
  try {
    state = await (await api("/api/state")).json();
    await loadLog();
    render();
    connectEvents();
  } catch (error) {
    $("status").textContent = String(error.message || error);
    $("status").className = "chip err";
  }
})();
