"use strict";

const port = chrome.runtime.connect({ name: "popup" });
let view = null;

const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.append(child);
  return node;
}

function selectionKey(selection) {
  if (!selection) return "";
  if (selection.mode === "tab") return `tab:${selection.tabId}`;
  if (selection.mode === "origin") return `origin:${selection.origin}`;
  return "active";
}

function choice(key, title, sub, selection, connected) {
  const current = view.daemon ? selectionKey(view.daemon.defaultSelection) : "";
  const input = el("input", {
    type: "radio",
    name: "target",
    value: key,
    checked: key === current,
    disabled: !view.connected,
  });
  input.addEventListener("change", () => port.postMessage({ type: "select", selection }));
  const label = el(
    "label",
    { className: `choice${connected ? " selected" : ""}` },
    input,
    el("span", {}, el("div", { className: "title", textContent: title }), el("div", { className: "sub", textContent: sub })),
  );
  return label;
}

function render() {
  if (!view) return;
  const d = view.daemon;
  $("connection").textContent = view.connected
    ? `Connected to the bridge on port ${view.port} · ${d ? d.sessions : 0} MCP client(s)`
    : "Bridge not running. Start your MCP client, or run: haven-agent-bridge daemon";

  const resolved = d ? d.resolvedTabId : null;
  const box = $("targets");
  box.replaceChildren();
  const active = view.targets.find((t) => t.tabId === resolved);
  box.append(
    choice(
      "active",
      "The allowed tab I used last",
      active && d && d.defaultSelection.mode === "active" ? `now: ${active.title || active.origin}` : "follows your tab switches",
      { mode: "active" },
      false,
    ),
  );
  const byOrigin = new Map();
  for (const t of view.targets) {
    if (!byOrigin.has(t.origin)) byOrigin.set(t.origin, []);
    byOrigin.get(t.origin).push(t);
  }
  for (const [origin, tabs] of byOrigin) {
    if (tabs.length > 1) {
      box.append(choice(`origin:${origin}`, `Any tab on ${origin}`, "the one used last", { mode: "origin", origin }, false));
    }
    for (const t of tabs) {
      box.append(
        choice(
          `tab:${t.tabId}`,
          t.title || origin,
          `${origin} · ${t.tools.length} tools${t.native ? "" : " · polyfill"}`,
          { mode: "tab", tabId: t.tabId, origin: t.origin },
          t.tabId === resolved,
        ),
      );
    }
  }
  if (!view.targets.length) {
    box.append(el("p", { className: "muted", textContent: "No allowed tab is open." }));
  }

  const silent = $("silent");
  silent.replaceChildren();
  for (const t of view.silentTabs) {
    const reload = el("button", { type: "button", className: "link", textContent: "Reload" });
    reload.addEventListener("click", () => port.postMessage({ type: "reload-tab", tabId: t.tabId }));
    silent.append(el("p", { className: "muted" }, `Not connected yet: ${t.title || t.origin} `, reload));
  }

  $("recording").checked = Boolean(d && d.recording);
  $("recording").disabled = !view.connected;
  $("open-ui").disabled = !(d && d.uiUrl);

  const list = $("origins");
  list.replaceChildren();
  for (const origin of view.origins) {
    const remove = el("button", { type: "button", className: "link", textContent: "Remove" });
    remove.setAttribute("aria-label", `Remove ${origin}`);
    remove.addEventListener("click", () => setOrigins(view.origins.filter((o) => o !== origin)));
    list.append(el("li", {}, el("span", { textContent: origin }), remove));
  }
}

async function setOrigins(origins) {
  const res = await chrome.runtime.sendMessage({ type: "popup:set-origins", origins });
  if (!res || !res.ok) showError(res ? res.error : "Could not save");
  port.postMessage({ type: "status" });
}

function showError(text) {
  const box = $("origin-error");
  box.textContent = text;
  box.hidden = !text;
}

$("add-origin").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  let origin;
  try {
    origin = new URL($("origin-input").value.trim()).origin;
  } catch {
    return showError("Enter a URL like https://example.com or http://localhost:5173");
  }
  if (!/^https?:/.test(origin)) return showError("Only http and https sites are supported.");
  const url = new URL(origin);
  // Permissions must be requested from the click itself.
  const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
  if (!granted) return showError("Chrome did not grant access to that site.");
  $("origin-input").value = "";
  await setOrigins([...view.origins, origin]);
});

$("recording").addEventListener("change", (event) => {
  port.postMessage({ type: "recording", recording: event.target.checked });
});

$("open-ui").addEventListener("click", () => {
  if (view && view.daemon && view.daemon.uiUrl) chrome.tabs.create({ url: view.daemon.uiUrl });
});

port.onMessage.addListener((msg) => {
  if (msg.type !== "status") return;
  view = msg;
  render();
});
port.postMessage({ type: "status" });
port.postMessage({ type: "reconnect" });
