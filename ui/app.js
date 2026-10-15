// Debug GUI of the Haven Agent Bridge. Everything shown comes from web pages
// and MCP clients, so it is always set as text, never as HTML.
"use strict";

const TOKEN_KEY = "haven-agent-bridge-token";
const SVG_NS = "http://www.w3.org/2000/svg";
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
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("aria-") || key === "role") node.setAttribute(key, value);
    else node[key] = value;
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function svg(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  for (const child of children) node.append(child);
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
let stats = null;
const entries = new Map(); // id -> entry
const expanded = new Set();
let view = "calls";

// --- formatting ---

function time(ms) {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function ago(ms) {
  if (!ms) return "never";
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return time(ms);
}
function size(bytes) {
  if (bytes === undefined || bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function ms(value) {
  if (value === undefined || value === null) return "";
  return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`;
}
function parseMaybe(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Stable colour per origin, so the same Haven instance always looks the same. */
function originColor(origin) {
  let hash = 0;
  for (const ch of origin || "") hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${hash % 360} 65% 52%)`;
}
function originChip(origin, suffix) {
  const short = String(origin || "").replace(/^https?:\/\//, "");
  const chip = el("span", { class: "origin", textContent: `${short}${suffix || ""}`, title: `${origin}${suffix || ""}` });
  chip.style.setProperty("--origin-color", originColor(origin));
  return chip;
}

/** JSON with syntax colours, built from text nodes only. */
function jsonPre(value, extraClass) {
  const pre = el("pre", { class: extraClass || "" });
  const parsed = parseMaybe(value);
  if (typeof parsed === "string") {
    pre.textContent = parsed;
    return pre;
  }
  const text = JSON.stringify(parsed, null, 2) ?? "undefined";
  const pattern = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) pre.append(text.slice(last, match.index));
    if (match[1]) {
      pre.append(el("span", { class: match[2] ? "j-key" : "j-str", textContent: match[1] }));
      if (match[2]) pre.append(match[2]);
    } else if (match[3]) {
      pre.append(el("span", { class: "j-lit", textContent: match[3] }));
    } else {
      pre.append(el("span", { class: "j-num", textContent: match[4] }));
    }
    last = match.index + match[0].length;
  }
  pre.append(text.slice(last));
  return pre;
}

function sparkline(values) {
  const max = Math.max(1, ...values);
  const w = 100;
  const h = 22;
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - 2 - (v / max) * (h - 4)).toFixed(1)}`).join(" ");
  return svg(
    "svg",
    { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", "aria-hidden": "true" },
    svg("polyline", { points, "stroke-width": 1.6, "vector-effect": "non-scaling-stroke" }),
  );
}

/** Calls per minute over the last `minutes`, from the entries in memory. */
function perMinute(minutes) {
  const now = Date.now();
  const ok = new Array(minutes).fill(0);
  const err = new Array(minutes).fill(0);
  for (const e of entries.values()) {
    if (e.kind !== "call") continue;
    const bucket = minutes - 1 - Math.floor((now - e.at) / 60000);
    if (bucket < 0 || bucket >= minutes) continue;
    if (e.status === "error") err[bucket] += 1;
    else ok[bucket] += 1;
  }
  return { ok, err };
}

// --- header, hero, KPIs ---

function defaultTarget() {
  return state && state.targets.find((t) => t.tabId === state.defaultTabId);
}

function describeSelection(selection) {
  if (!selection) return "default tab";
  if (selection.mode === "active") return "follows the tab used last";
  if (selection.mode === "origin") return `any tab on ${selection.origin}`;
  return `pinned to tab #${selection.tabId}`;
}

function renderHeader() {
  if (!state) return;
  $("version").textContent = `v${state.version} · port ${state.port}`;
  const ext = state.extension;
  const pill = $("status");
  pill.textContent = ext.connected ? "Browser connected" : "Browser not connected";
  pill.className = `pill ${ext.connected ? "ok" : "err"}`;

  const target = defaultTarget();
  $("hero-title").textContent = target ? target.title || target.origin : ext.connected ? "No allowed tab selected" : "Waiting for the browser…";
  const sub = $("hero-sub");
  sub.replaceChildren();
  if (target) {
    sub.append(originChip(target.origin), ` · ${target.tools.length} tools · ${describeSelection(state.settings.defaultSelection)} · ${state.sessions.length} client(s)`);
  } else {
    sub.textContent = ext.connected
      ? "Open Haven (or another allowed site) in Chrome; reload tabs that were open before the extension."
      : "Is Chrome running with the Haven Agent Bridge extension?";
  }

  $("recording").checked = state.settings.recording;
  $("fallback").checked = state.settings.fallbackTools;
  $("recording-hint").hidden = state.settings.recording;
  $("nav-tools").textContent = target ? String(target.tools.length) : "";
  $("nav-targets").textContent = String(state.targets.length);
  renderKpis();
}

function renderKpis() {
  const totals = stats ? stats.totals : { calls: 0, errors: 0 };
  const p95 = stats && stats.tools.length ? Math.max(...stats.tools.map((t) => t.p95Ms)) : null;
  const series = perMinute(30);
  const rate = totals.calls ? Math.round((100 * totals.errors) / totals.calls) : 0;
  const kpi = (label, value, extra, bad) =>
    el("div", { class: "kpi" }, el("span", { class: `value${bad ? " bad" : ""}`, textContent: value }), el("span", { class: "label", textContent: label }), extra);
  $("kpis").replaceChildren(
    kpi("calls", String(totals.calls), sparkline(series.ok.map((v, i) => v + series.err[i]))),
    kpi("error rate", totals.calls ? `${rate} %` : "–", sparkline(series.err), rate >= 20),
    kpi("slowest p95", p95 === null ? "–" : ms(p95)),
    kpi("clients", String(state ? state.sessions.length : 0)),
  );
  $("nav-calls").textContent = String(totals.calls || "");
}

$("recording").addEventListener("change", (e) => post("/api/settings", { recording: e.target.checked }));
$("fallback").addEventListener("change", (e) => post("/api/settings", { fallbackTools: e.target.checked }));
$("clear").addEventListener("click", async () => {
  if (!confirm("Clear the log and the statistics?")) return;
  await post("/api/clear", {});
  entries.clear();
  expanded.clear();
  await loadLog();
  await refreshStats();
  renderLog();
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
  if (view === "stats") renderStats();
}

// --- calls ---

let renderQueued = false;
function queueLog() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (view === "calls") renderLog();
    renderKpis();
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

const KIND_LABEL = {
  call: "call",
  tools_list: "tools/list",
  list_changed: "list_changed",
  targets: "tabs",
  session: "client",
  extension: "browser",
  note: "note",
};

function renderLog() {
  const query = $("filter").value.trim().toLowerCase();
  const showEvents = $("show-events").checked;
  const errorsOnly = $("errors-only").checked;
  const list = [...entries.values()]
    .filter((e) => (showEvents || e.kind === "call") && (!errorsOnly || e.status === "error") && matches(e, query))
    .sort((a, b) => b.id - a.id)
    .slice(0, 500);
  $("log-count").textContent = `${list.length} of ${entries.size} entries`;
  $("log-empty").hidden = list.length > 0;
  const slowest = Math.max(1, ...list.filter((e) => e.durationMs !== undefined).map((e) => e.durationMs));
  const body = $("log-body");
  body.replaceChildren();
  for (const e of list) {
    const open = expanded.has(e.id);
    const duration =
      e.durationMs !== undefined
        ? el(
            "span",
            { class: "duration" },
            ms(e.durationMs),
            (() => {
              const bar = el("span", { class: `bar${e.durationMs > 2000 ? " slow" : ""}` }, el("i"));
              bar.firstChild.style.width = `${Math.max(4, (100 * e.durationMs) / slowest)}%`;
              return bar;
            })(),
          )
        : "";
    const row = el(
      "tr",
      { class: `row${open ? " open" : ""}`, tabIndex: 0, "aria-expanded": String(open) },
      el("td", { class: "time", textContent: time(e.at) }),
      el("td", {}, el("span", { class: `tag ${e.kind}`, textContent: KIND_LABEL[e.kind] || e.kind })),
      el("td", { class: "what" }, e.kind === "call" ? el("span", { class: "call", textContent: e.tool }) : el("span", { class: "event", textContent: e.title })),
      el("td", { class: "client", textContent: e.client || "" }),
      el("td", {}, e.origin ? originChip(e.origin) : ""),
      el("td", {}, el("span", { class: `status ${e.status}`, textContent: e.status === "info" ? "event" : e.status })),
      el("td", { class: "num" }, duration),
      el("td", { class: "num muted", textContent: size(e.bytes) }),
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
    if (open) body.append(detailRow(e));
  }
}

function pane(label, value, isError) {
  return el("div", {}, el("div", { class: `pane-title${isError ? " err" : ""}`, textContent: label }), jsonPre(value, isError ? "err" : ""));
}

function detailRow(e) {
  const parts = [];
  if (e.kind === "call") {
    if (e.args !== undefined) parts.push(pane("Arguments", e.args));
    if (e.result !== undefined) parts.push(pane("Response", e.result));
    if (e.error !== undefined) parts.push(pane("Error", e.error, true));
    if (e.payloadOmitted) {
      parts.push(el("p", { class: "muted", textContent: "Arguments and response were not recorded (Record payloads was off)." }));
    }
  }
  if (e.detail !== undefined) parts.push(pane("Detail", e.detail));
  const copy = el("button", { type: "button", textContent: "Copy as JSON" });
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(e, null, 2));
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy as JSON"), 1200);
  });
  const head = el(
    "div",
    { class: "detail-head" },
    el("span", { textContent: `#${e.id}` }),
    el("span", { textContent: new Date(e.at).toISOString() }),
    e.tabId !== undefined ? el("span", { textContent: `tab #${e.tabId}` }) : null,
    e.sessionId ? el("span", { class: "mono", textContent: `session ${e.sessionId.slice(0, 8)}` }) : null,
    copy,
  );
  return el("tr", { class: "detail" }, el("td", { colSpan: 8 }, head, el("div", { class: "detail-grid" }, ...parts)));
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
      p.default !== undefined
        ? p.default
        : Array.isArray(p.enum)
          ? p.enum[0]
          : p.type === "number" || p.type === "integer"
            ? 0
            : p.type === "boolean"
              ? false
              : p.type === "array"
                ? []
                : p.type === "object"
                  ? {}
                  : "";
  }
  return out;
}

function toolUsage(tool, origin) {
  if (!stats) return null;
  return stats.tools.find((s) => s.tool === tool && s.origin === origin) || null;
}

function renderToolList() {
  const target = state.targets.find((t) => String(t.tabId) === $("tools-tab").value);
  const box = $("tools-list");
  box.replaceChildren();
  if (!target) {
    box.append(el("p", { class: "empty card", textContent: "No allowed tab with tools is open." }));
    $("tools-count").textContent = "";
    return;
  }
  const query = $("tools-filter").value.trim().toLowerCase();
  const tools = target.tools.filter((t) => !query || `${t.name}\n${t.description}`.toLowerCase().includes(query));
  $("tools-count").textContent = `${tools.length} of ${target.tools.length} tools · registration #${target.generation}`;
  for (const tool of tools) {
    const a = tool.annotations || {};
    const schema = tool.inputSchema || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const params = Object.keys(schema.properties || {});
    const usage = toolUsage(tool.name, target.origin);

    const desc = el("p", { class: "tool-desc", textContent: tool.description || "No description." });
    desc.addEventListener("click", () => desc.classList.toggle("full"));

    const schemaPre = jsonPre(schema);
    schemaPre.hidden = true;
    const tryBox = el("div", { class: "try", hidden: true });
    const input = el("textarea", { value: JSON.stringify(skeleton(schema), null, 2), spellcheck: false, "aria-label": `Input for ${tool.name}` });
    const output = el("div");
    const run = el("button", { type: "button", class: "primary", textContent: "Run in this tab" });
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
        output.replaceChildren(jsonPre(result.structuredContent ?? result.content, result.isError ? "err" : ""));
      } catch (error) {
        note.textContent = String(error);
      } finally {
        run.disabled = false;
      }
    });
    tryBox.append(input, el("div", { class: "actions" }, run, note), output);

    const schemaButton = el("button", { type: "button", textContent: "Schema" });
    schemaButton.addEventListener("click", () => (schemaPre.hidden = !schemaPre.hidden));
    const tryButton = el("button", { type: "button", textContent: "Try it" });
    tryButton.addEventListener("click", () => {
      tryBox.hidden = !tryBox.hidden;
      if (!tryBox.hidden) input.focus();
    });

    box.append(
      el(
        "div",
        { class: "tool card" },
        el(
          "div",
          { class: "tool-head" },
          el("span", { class: "tool-name", textContent: tool.name }),
          a.readOnlyHint ? el("span", { class: "badge ro", textContent: "read-only" }) : null,
          a.consequentialHint ? el("span", { class: "badge cq", textContent: "consequential" }) : null,
          a.untrustedContentHint ? el("span", { class: "badge ut", textContent: "untrusted content" }) : null,
        ),
        desc,
        params.length
          ? el("div", { class: "tool-meta" }, ...params.map((p) => el("span", { class: `param${required.has(p) ? " req" : ""}`, textContent: required.has(p) ? `${p}*` : p })))
          : el("div", { class: "tool-meta", textContent: "no parameters" }),
        usage
          ? el("div", { class: "tool-meta", textContent: `${usage.calls} call(s) · ${usage.errors} error(s) · p95 ${ms(usage.p95Ms)}` })
          : null,
        el("div", { class: "tool-actions" }, tryButton, schemaButton),
        schemaPre,
        tryBox,
      ),
    );
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
  const key = !current
    ? "default"
    : current.mode === "active"
      ? "active"
      : current.mode === "origin"
        ? `origin:${current.origin}`
        : `tab:${current.tabId}:${current.origin}`;
  if (![...select.options].some((o) => o.value === key)) {
    add(key, current && current.mode === "tab" ? `Tab #${current.tabId} on ${current.origin} (gone)` : `${current?.origin ?? key} (not open)`);
  }
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
  const resolved = defaultTarget();
  const res = $("default-resolved");
  res.replaceChildren();
  if (resolved) res.append("→ ", originChip(resolved.origin), ` ${resolved.title || ""}`);
  else res.textContent = "→ no matching tab";

  const body = $("targets-body");
  body.replaceChildren();
  for (const t of state.targets) {
    body.append(
      el(
        "tr",
        { class: t.tabId === state.defaultTabId ? "is-default" : "" },
        el("td", { class: "mono", textContent: `#${t.tabId}` }),
        el("td", { textContent: t.title }),
        el("td", {}, originChip(t.origin)),
        el("td", { class: "num", textContent: String(t.tools.length) }),
        el("td", {}, el("span", { class: `tag${t.native ? " call" : ""}`, textContent: t.native ? "native" : "polyfill" })),
        el("td", { class: "num", textContent: String(t.generation) }),
        el("td", { class: "muted", textContent: ago(t.lastActiveAt) }),
      ),
    );
  }
  if (!state.targets.length) body.append(el("tr", {}, el("td", { colSpan: 7, class: "empty", textContent: "No allowed tab is open." })));

  const sessions = $("sessions-body");
  sessions.replaceChildren();
  for (const s of state.sessions) {
    const select = el("select", { "aria-label": `Tab for ${s.client}` });
    selectionOptions(select, s.selection, true);
    select.addEventListener("change", () => post(`/api/sessions/${encodeURIComponent(s.id)}/selection`, { selection: parseSelection(select.value) }));
    const tab = state.targets.find((t) => t.tabId === s.tabId);
    sessions.append(
      el(
        "tr",
        {},
        el("td", { textContent: s.client }),
        el("td", { class: "muted", textContent: ago(s.createdAt) }),
        el("td", { class: "muted", textContent: ago(s.lastSeenAt) }),
        el("td", {}, select),
        el("td", {}, tab ? originChip(tab.origin, ` #${tab.tabId}`) : el("span", { class: "muted", textContent: "no tab" })),
      ),
    );
  }
  if (!state.sessions.length) sessions.append(el("tr", {}, el("td", { colSpan: 5, class: "empty", textContent: "No MCP client connected." })));

  const ext = state.extension;
  $("extension-info").textContent = ext.connected
    ? `Extension ${ext.version} · allowed origins: ${(ext.origins || []).join(", ")}`
    : "The browser extension is not connected.";
}

// --- stats ---

async function refreshStats() {
  try {
    stats = await (await api("/api/stats")).json();
  } catch {
    return;
  }
  renderKpis();
  if (view === "stats") renderStats();
}

function renderTimeline() {
  const minutes = 30;
  const { ok, err } = perMinute(minutes);
  const max = Math.max(1, ...ok.map((v, i) => v + err[i]));
  const W = 600;
  const H = 140;
  const top = 10;
  const bottom = 22;
  const bw = W / minutes;
  const plot = H - top - bottom;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": "Calls per minute" });
  root.append(svg("line", { class: "axis", x1: 0, x2: W, y1: H - bottom, y2: H - bottom }));
  for (let i = 0; i < minutes; i++) {
    const okH = (ok[i] / max) * plot;
    const errH = (err[i] / max) * plot;
    const x = i * bw + 2;
    if (ok[i]) root.append(svg("rect", { class: "bar-ok", x, y: H - bottom - okH, width: bw - 4, height: okH, rx: 2 }));
    if (err[i]) root.append(svg("rect", { class: "bar-err", x, y: H - bottom - okH - errH, width: bw - 4, height: errH, rx: 2 }));
  }
  root.append(svg("text", { x: 0, y: H - 6 }, document.createTextNode("−30 min")));
  root.append(svg("text", { x: W, y: H - 6, "text-anchor": "end" }, document.createTextNode("now")));
  root.append(svg("text", { x: 0, y: top + 2 }, document.createTextNode(`${max}/min`)));
  $("stats-timeline").replaceChildren(root);
}

function trackBar(okCount, errCount, max) {
  const bar = el("div", { class: "track-bar" });
  const okPart = el("i", { class: "ok" });
  const errPart = el("i", { class: "err" });
  okPart.style.width = `${(100 * okCount) / max}%`;
  errPart.style.width = `${(100 * errCount) / max}%`;
  bar.append(okPart, errPart);
  return bar;
}

function renderStats() {
  renderTimeline();
  if (!stats) return;
  const clientMax = Math.max(1, ...stats.clients.map((c) => c.calls));
  const clients = $("stats-clients-bars");
  clients.replaceChildren(
    ...stats.clients.map((c) =>
      el(
        "div",
        { class: "hbar" },
        el("span", { class: "name", textContent: c.client }),
        el("span", { class: "val", textContent: `${c.calls} · ${ms(c.avgMs)} avg` }),
        trackBar(c.calls - c.errors, c.errors, clientMax),
      ),
    ),
  );
  if (!stats.clients.length) clients.append(el("p", { class: "muted", textContent: "No calls yet." }));

  const callMax = Math.max(1, ...stats.tools.map((t) => t.calls));
  const latencyMax = Math.max(1, ...stats.tools.map((t) => t.p95Ms));
  const tools = $("stats-tools");
  tools.replaceChildren(
    ...stats.tools.map((s) => {
      const latency = el("div", { class: "latency" }, el("i", { class: "p95" }), el("i", { class: "p50" }));
      latency.children[0].style.width = `${(100 * s.p95Ms) / latencyMax}%`;
      latency.children[1].style.width = `${(100 * s.p50Ms) / latencyMax}%`;
      return el(
        "tr",
        {},
        el("td", {}, el("div", { class: "mono", textContent: s.tool }), originChip(s.origin)),
        el("td", { class: "calls-cell" }, el("span", { textContent: `${s.calls} (${s.errors} failed)` }), trackBar(s.calls - s.errors, s.errors, callMax)),
        el("td", { class: `num${s.errorRate >= 0.2 ? " rate-bad" : ""}`, textContent: `${Math.round(s.errorRate * 100)} %` }),
        el("td", {}, el("span", { class: "muted", textContent: `${ms(s.p50Ms)} / ${ms(s.p95Ms)}` }), latency),
        el("td", { class: "num", textContent: ms(s.maxMs) }),
        el("td", { class: "num", textContent: size(s.avgBytes) }),
        el("td", { class: "muted", textContent: ago(s.lastAt) }),
      );
    }),
  );
  if (!stats.tools.length) tools.append(el("tr", {}, el("td", { colSpan: 7, class: "empty", textContent: "No calls yet." })));
}

// --- live updates ---

async function loadLog() {
  const list = await (await api("/api/log")).json();
  for (const e of list) entries.set(e.id, e);
}

let statsTimer = null;
function scheduleStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(refreshStats, 400);
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
    if (entry.kind === "call" && entry.status !== "running") scheduleStats();
  });
  source.onerror = () => {
    $("status").textContent = "Bridge not reachable, retrying…";
    $("status").className = "pill err";
  };
}

(async () => {
  if (!token) {
    $("status").textContent = "No token";
    $("status").className = "pill err";
    $("hero-title").textContent = "Open the GUI from the extension popup or with `haven-agent-bridge ui`.";
    return;
  }
  try {
    state = await (await api("/api/state")).json();
    await loadLog();
    await refreshStats();
    render();
    connectEvents();
    // Relative times ("2 min ago") and the per-minute charts move on their own.
    setInterval(() => {
      renderKpis();
      if (view === "stats") renderStats();
    }, 15000);
  } catch (error) {
    $("status").textContent = "Error";
    $("status").className = "pill err";
    $("hero-title").textContent = String(error.message || error);
  }
})();
