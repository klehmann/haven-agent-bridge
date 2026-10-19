// Debug GUI of the Haven Agent Bridge. Everything shown comes from web pages
// and MCP clients, so it is always set as text, never as HTML.
// Texts come from i18n.js (t, tc, tNodes, num, LOCALE), loaded before this file.
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

localize(document);
$("fallback-help").replaceChildren(
  ...tNodes("fallbackToolsHelp", {
    listTool: el("code", { textContent: "bridge_tools_list" }),
    callTool: el("code", { textContent: "bridge_tool_call" }),
  }),
);
$("recording-hint").replaceChildren(...tNodes("recordingHint", { setting: el("strong", { textContent: t("recordPayloads") }) }));

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
  if (res.status === 401) throw new Error(t("wrongToken"));
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
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
function ago(ms) {
  if (!ms) return t("never");
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 5) return t("justNow");
  const relative = new Intl.RelativeTimeFormat(LOCALE, { style: "short" });
  if (s < 60) return relative.format(-s, "second");
  if (s < 3600) return relative.format(-Math.round(s / 60), "minute");
  return time(ms);
}
function size(bytes) {
  if (bytes === undefined || bytes === null) return "";
  const unit = (value, name, digits) =>
    num(value, { style: "unit", unit: name, unitDisplay: "short", minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (bytes < 1024) return unit(bytes, "byte", 0);
  if (bytes < 1024 * 1024) return unit(bytes / 1024, "kilobyte", 1);
  return unit(bytes / 1024 / 1024, "megabyte", 1);
}
function ms(value) {
  if (value === undefined || value === null) return "";
  return value < 1000
    ? num(value, { style: "unit", unit: "millisecond", unitDisplay: "short", maximumFractionDigits: 0 })
    : num(value / 1000, { style: "unit", unit: "second", unitDisplay: "short", minimumFractionDigits: 1, maximumFractionDigits: 1 });
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
  if (!selection) return t("selDefault");
  if (selection.mode === "active") return t("selActive");
  if (selection.mode === "origin") return t("selOrigin", { origin: selection.origin });
  return t("selTab", { tabId: selection.tabId });
}

function renderHeader() {
  if (!state) return;
  $("version").textContent = t("versionLine", { version: state.version, port: state.port });
  const ext = state.extension;
  const pill = $("status");
  pill.textContent = ext.connected ? t("browserConnected") : t("browserNotConnected");
  pill.className = `pill ${ext.connected ? "ok" : "err"}`;

  const target = defaultTarget();
  $("hero-title").textContent = target ? target.title || target.origin : ext.connected ? t("heroNoTab") : t("heroWaiting");
  const sub = $("hero-sub");
  sub.replaceChildren();
  if (target) {
    sub.append(originChip(target.origin), ` · ${tc("toolsCount", target.tools.length)} · ${describeSelection(state.settings.defaultSelection)} · ${tc("clientsCount", state.sessions.length)}`);
  } else {
    sub.textContent = ext.connected
      ? t("heroHintConnected")
      : t("heroHintDisconnected");
  }

  $("recording").checked = state.settings.recording;
  $("fallback").checked = state.settings.fallbackTools;
  $("recording-hint").hidden = state.settings.recording;
  $("nav-tools").textContent = target ? num(target.tools.length) : "";
  $("nav-targets").textContent = num(state.targets.length);
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
    kpi(t("kpiCalls"), num(totals.calls), sparkline(series.ok.map((v, i) => v + series.err[i]))),
    kpi(t("kpiErrorRate"), totals.calls ? num(rate / 100, { style: "percent" }) : "–", sparkline(series.err), rate >= 20),
    kpi(t("kpiSlowest"), p95 === null ? "–" : ms(p95)),
    kpi(t("kpiClients"), num(state ? state.sessions.length : 0)),
  );
  $("nav-calls").textContent = totals.calls ? num(totals.calls) : "";
}

$("recording").addEventListener("change", (e) => post("/api/settings", { recording: e.target.checked }));
$("fallback").addEventListener("change", (e) => post("/api/settings", { fallbackTools: e.target.checked }));
$("clear").addEventListener("click", async () => {
  if (!confirm(t("confirmClear"))) return;
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

// tools/list and list_changed are MCP protocol names and stay as they are.
const KIND_LABEL = {
  call: t("kindCall"),
  tools_list: "tools/list",
  list_changed: "list_changed",
  targets: t("kindTabs"),
  session: t("kindClient"),
  extension: t("kindBrowser"),
  note: t("kindNote"),
};
const STATUS_LABEL = {
  ok: t("statusOk"),
  error: t("statusError"),
  running: t("statusRunning"),
  info: t("statusEvent"),
};

function renderLog() {
  const query = $("filter").value.trim().toLowerCase();
  const showEvents = $("show-events").checked;
  const errorsOnly = $("errors-only").checked;
  const list = [...entries.values()]
    .filter((e) => (showEvents || e.kind === "call") && (!errorsOnly || e.status === "error") && matches(e, query))
    .sort((a, b) => b.id - a.id)
    .slice(0, 500);
  $("log-count").textContent = tc("logCount", entries.size, { shown: num(list.length) });
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
      el("td", {}, el("span", { class: `status ${e.status}`, textContent: STATUS_LABEL[e.status] || e.status })),
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
    if (e.args !== undefined) parts.push(pane(t("paneArguments"), e.args));
    if (e.result !== undefined) parts.push(pane(t("paneResponse"), e.result));
    if (e.error !== undefined) parts.push(pane(t("paneError"), e.error, true));
    if (e.payloadOmitted) {
      parts.push(el("p", { class: "muted", textContent: t("payloadOmitted") }));
    }
  }
  if (e.detail !== undefined) parts.push(pane(t("paneDetail"), e.detail));
  const copy = el("button", { type: "button", textContent: t("copyJson") });
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    navigator.clipboard.writeText(JSON.stringify(e, null, 2));
    copy.textContent = t("copied");
    setTimeout(() => (copy.textContent = t("copyJson")), 1200);
  });
  const head = el(
    "div",
    { class: "detail-head" },
    el("span", { textContent: `#${e.id}` }),
    el("span", { textContent: new Date(e.at).toISOString() }),
    e.tabId !== undefined ? el("span", { textContent: t("tabRef", { tabId: e.tabId }) }) : null,
    e.sessionId ? el("span", { class: "mono", textContent: t("sessionRef", { id: e.sessionId.slice(0, 8) }) }) : null,
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
    box.append(el("p", { class: "empty card", textContent: t("noToolsTab") }));
    $("tools-count").textContent = "";
    return;
  }
  const query = $("tools-filter").value.trim().toLowerCase();
  const tools = target.tools.filter((t) => !query || `${t.name}\n${t.description}`.toLowerCase().includes(query));
  $("tools-count").textContent = tc("toolsOf", target.tools.length, { shown: num(tools.length), generation: target.generation });
  for (const tool of tools) {
    const a = tool.annotations || {};
    const schema = tool.inputSchema || {};
    const required = new Set(Array.isArray(schema.required) ? schema.required : []);
    const params = Object.keys(schema.properties || {});
    const usage = toolUsage(tool.name, target.origin);

    const desc = el("p", { class: "tool-desc", textContent: tool.description || t("noDescription") });
    desc.addEventListener("click", () => desc.classList.toggle("full"));

    const schemaPre = jsonPre(schema);
    schemaPre.hidden = true;
    const tryBox = el("div", { class: "try", hidden: true });
    const input = el("textarea", { value: JSON.stringify(skeleton(schema), null, 2), spellcheck: false, "aria-label": t("inputFor", { tool: tool.name }) });
    const output = el("div");
    const run = el("button", { type: "button", class: "primary", textContent: t("runInTab") });
    const note = el("span", { class: "muted" });
    run.addEventListener("click", async () => {
      let args;
      try {
        args = JSON.parse(input.value || "{}");
      } catch (error) {
        note.textContent = t("invalidJson", { message: error.message });
        return;
      }
      if (a.consequentialHint && !confirm(t("confirmConsequential", { tool: tool.name }))) return;
      run.disabled = true;
      note.textContent = t("running");
      const started = performance.now();
      try {
        const result = await post("/api/call", { tabId: target.tabId, name: tool.name, args });
        note.textContent = `${result.isError ? t("statusError") : t("statusOk")} · ${ms(Math.round(performance.now() - started))}`;
        output.replaceChildren(jsonPre(result.structuredContent ?? result.content, result.isError ? "err" : ""));
      } catch (error) {
        note.textContent = String(error);
      } finally {
        run.disabled = false;
      }
    });
    tryBox.append(input, el("div", { class: "actions" }, run, note), output);

    const schemaButton = el("button", { type: "button", textContent: t("schema") });
    schemaButton.addEventListener("click", () => (schemaPre.hidden = !schemaPre.hidden));
    const tryButton = el("button", { type: "button", textContent: t("tryIt") });
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
          a.readOnlyHint ? el("span", { class: "badge ro", textContent: t("badgeReadOnly") }) : null,
          a.consequentialHint ? el("span", { class: "badge cq", textContent: t("badgeConsequential") }) : null,
          a.untrustedContentHint ? el("span", { class: "badge ut", textContent: t("badgeUntrusted") }) : null,
        ),
        desc,
        params.length
          ? el("div", { class: "tool-meta" }, ...params.map((p) => el("span", { class: `param${required.has(p) ? " req" : ""}`, textContent: required.has(p) ? `${p}*` : p })))
          : el("div", { class: "tool-meta", textContent: t("noParameters") }),
        usage
          ? el("div", { class: "tool-meta", textContent: `${tc("callsCount", usage.calls)} · ${tc("errorsCount", usage.errors)} · p95 ${ms(usage.p95Ms)}` })
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
  if (includeDefault) add("default", t("optDefaultTab"));
  add("active", t("optActive"));
  const origins = [...new Set(state.targets.map((t) => t.origin))];
  for (const origin of origins) add(`origin:${origin}`, t("optOrigin", { origin }));
  for (const tab of state.targets) add(`tab:${tab.tabId}:${tab.origin}`, t("optTab", { tabId: tab.tabId, title: tab.title || tab.origin }));
  const key = !current
    ? "default"
    : current.mode === "active"
      ? "active"
      : current.mode === "origin"
        ? `origin:${current.origin}`
        : `tab:${current.tabId}:${current.origin}`;
  if (![...select.options].some((o) => o.value === key)) {
    add(key, current && current.mode === "tab"
        ? t("optTabGone", { tabId: current.tabId, origin: current.origin })
        : t("optNotOpen", { origin: current?.origin ?? key }),);
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
  else res.textContent = `→ ${t("noMatchingTab")}`;

  const body = $("targets-body");
  body.replaceChildren();
  for (const tab of state.targets) {
    body.append(
      el(
        "tr",
        { class: tab.tabId === state.defaultTabId ? "is-default" : "" },
        el("td", { class: "mono", textContent: `#${tab.tabId}` }),
        el("td", { textContent: tab.title }),
        el("td", {}, originChip(tab.origin)),
        el("td", { class: "num", textContent: num(tab.tools.length) }),
        el("td", {}, el("span", { class: `tag${tab.native ? " call" : ""}`, textContent: tab.native ? t("native") : t("polyfill") })),
        el("td", { class: "num", textContent: num(tab.generation) }),
        el("td", { class: "muted", textContent: ago(tab.lastActiveAt) }),
      ),
    );
  }
  if (!state.targets.length) body.append(el("tr", {}, el("td", { colSpan: 7, class: "empty", textContent: t("noAllowedTab") })));

  const sessions = $("sessions-body");
  sessions.replaceChildren();
  for (const s of state.sessions) {
    const select = el("select", { "aria-label": t("tabForClient", { client: s.client }) });
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
        el("td", {}, tab ? originChip(tab.origin, ` #${tab.tabId}`) : el("span", { class: "muted", textContent: t("noTab") })),
      ),
    );
  }
  if (!state.sessions.length) sessions.append(el("tr", {}, el("td", { colSpan: 5, class: "empty", textContent: t("noClients") })));

  const ext = state.extension;
  $("extension-info").textContent = ext.connected
    ? t("extensionInfo", { version: ext.version, origins: new Intl.ListFormat(LOCALE, { type: "unit" }).format(ext.origins || []) })
    : t("extensionNotConnected");
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
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": t("callsPerMinute") });
  root.append(svg("line", { class: "axis", x1: 0, x2: W, y1: H - bottom, y2: H - bottom }));
  for (let i = 0; i < minutes; i++) {
    const okH = (ok[i] / max) * plot;
    const errH = (err[i] / max) * plot;
    const x = i * bw + 2;
    if (ok[i]) root.append(svg("rect", { class: "bar-ok", x, y: H - bottom - okH, width: bw - 4, height: okH, rx: 2 }));
    if (err[i]) root.append(svg("rect", { class: "bar-err", x, y: H - bottom - okH - errH, width: bw - 4, height: errH, rx: 2 }));
  }
  root.append(svg("text", { x: 0, y: H - 6 }, document.createTextNode(num(-30, { style: "unit", unit: "minute", unitDisplay: "short" }))));
  root.append(svg("text", { x: W, y: H - 6, "text-anchor": "end" }, document.createTextNode(t("axisNow"))));
  root.append(svg("text", { x: 0, y: top + 2 }, document.createTextNode(t("perMinuteMax", { count: num(max) }))));
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
        el("span", { class: "val", textContent: t("clientAvg", { calls: num(c.calls), avg: ms(c.avgMs) }) }),
        trackBar(c.calls - c.errors, c.errors, clientMax),
      ),
    ),
  );
  if (!stats.clients.length) clients.append(el("p", { class: "muted", textContent: t("noCallsYet") }));

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
        el("td", { class: "calls-cell" }, el("span", { textContent: t("callsFailed", { calls: num(s.calls), failed: num(s.errors) }) }), trackBar(s.calls - s.errors, s.errors, callMax)),
        el("td", { class: `num${s.errorRate >= 0.2 ? " rate-bad" : ""}`, textContent: num(s.errorRate, { style: "percent" }) }),
        el("td", {}, el("span", { class: "muted", textContent: `${ms(s.p50Ms)} / ${ms(s.p95Ms)}` }), latency),
        el("td", { class: "num", textContent: ms(s.maxMs) }),
        el("td", { class: "num", textContent: size(s.avgBytes) }),
        el("td", { class: "muted", textContent: ago(s.lastAt) }),
      );
    }),
  );
  if (!stats.tools.length) tools.append(el("tr", {}, el("td", { colSpan: 7, class: "empty", textContent: t("noCallsYet") })));
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
    $("status").textContent = t("bridgeUnreachable");
    $("status").className = "pill err";
  };
}

(async () => {
  if (!token) {
    $("status").textContent = t("noToken");
    $("status").className = "pill err";
    $("hero-title").textContent = t("openFromExtension");
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
    $("status").textContent = t("error");
    $("status").className = "pill err";
    $("hero-title").textContent = String(error.message || error);
  }
})();
