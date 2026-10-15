// Relay between the page world (content-main.js) and the extension. Only
// messages carrying the nonce content-main.js generated are passed on.
"use strict";

(() => {
  const nonce = () => document.documentElement && document.documentElement.dataset.havenAgentBridge;

  function toExtension(message) {
    try {
      chrome.runtime.sendMessage(message).catch(() => {});
    } catch {
      // The extension was reloaded; this page keeps the old script until reload.
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    const current = nonce();
    if (!data || data.source !== "hab-main" || !current || data.nonce !== current) return;
    if (data.type === "tools") {
      toExtension({ type: "tools", native: Boolean(data.native), tools: Array.isArray(data.tools) ? data.tools : [] });
    } else if (data.type === "tool-result") {
      toExtension({ type: "tool-result", callId: data.callId, ok: data.ok, result: data.result, error: data.error });
    }
  });

  chrome.runtime.onMessage.addListener((message) => {
    const current = nonce();
    if (!current || !message || (message.type !== "execute-tool" && message.type !== "re-announce")) return;
    window.postMessage({ ...message, source: "hab-isolated", nonce: current }, window.location.origin);
  });

  window.addEventListener("pagehide", () => toExtension({ type: "page-gone" }));

  // The page world may have announced before this listener existed.
  const current = nonce();
  if (current) {
    window.postMessage({ type: "re-announce", source: "hab-isolated", nonce: current }, window.location.origin);
  }
})();
