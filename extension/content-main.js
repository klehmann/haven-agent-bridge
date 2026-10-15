// Runs in the page's own JavaScript world at document_start, before the page's
// scripts. It wraps the WebMCP registration methods so the extension learns
// every tool the page registers or removes, and runs a tool when the bridge
// asks. Pages without native WebMCP get a polyfill, so their tools show up too.
//
// The idea of wrapping the ModelContext prototype from a MAIN-world content
// script and relaying through an ISOLATED-world script with a nonce comes from
// webmcp-bridge (MIT, (c) 2025 Nathan Gage); see THIRD_PARTY_NOTICES.md.
"use strict";

(() => {
  if (window.__havenAgentBridge) return;

  const NONCE = crypto.randomUUID();
  Object.defineProperty(window, "__havenAgentBridge", { value: { nonce: NONCE }, enumerable: false });
  document.documentElement.dataset.havenAgentBridge = NONCE;

  /** name -> { tool, execute } */
  const tools = new Map();
  let native = true;
  let announceTimer = null;

  function post(type, payload) {
    window.postMessage({ source: "hab-main", nonce: NONCE, type, ...payload }, window.location.origin);
  }

  function plain(value) {
    if (value === undefined) return undefined;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return undefined;
    }
  }

  function describe(tool) {
    const schema = plain(tool.inputSchema);
    const annotations = plain(tool.annotations);
    return {
      name: String(tool.name),
      description: typeof tool.description === "string" ? tool.description : "",
      inputSchema: schema && typeof schema === "object" ? schema : { type: "object", properties: {} },
      ...(annotations && typeof annotations === "object" ? { annotations } : {}),
    };
  }

  function announceNow() {
    clearTimeout(announceTimer);
    announceTimer = null;
    post("tools", { native, tools: [...tools.values()].map((entry) => entry.tool) });
  }

  // Pages often replace all their tools at once (unregister everything,
  // register the new set); one message for the whole burst.
  function announce() {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(announceNow, 30);
  }

  function remember(tool, signal) {
    if (!tool || typeof tool.name !== "string" || typeof tool.execute !== "function") return;
    if (signal && signal.aborted) return;
    const entry = { tool: describe(tool), execute: tool.execute };
    tools.set(tool.name, entry);
    if (signal && typeof signal.addEventListener === "function") {
      signal.addEventListener(
        "abort",
        () => {
          if (tools.get(tool.name) === entry) {
            tools.delete(tool.name);
            announce();
          }
        },
        { once: true },
      );
    }
    announce();
  }

  // --- polyfill for browsers without WebMCP ---
  if (!document.modelContext && !navigator.modelContext) {
    native = false;
    class ModelContext {
      registerTool() {}
      unregisterTool() {}
      provideContext() {}
      clearContext() {}
    }
    const instance = new ModelContext();
    for (const owner of [navigator, document]) {
      Object.defineProperty(owner, "modelContext", { value: instance, enumerable: true, configurable: true });
    }
  }

  // --- wrap every prototype the page could register through ---
  const wrapped = Symbol.for("haven-agent-bridge.wrapped");
  const prototypes = new Set();
  for (const candidate of [document.modelContext, navigator.modelContext]) {
    if (candidate && typeof candidate === "object") prototypes.add(Object.getPrototypeOf(candidate));
  }
  if (typeof window.ModelContext === "function") prototypes.add(window.ModelContext.prototype);

  for (const proto of prototypes) {
    if (!proto || proto[wrapped]) continue;
    Object.defineProperty(proto, wrapped, { value: true });

    const register = proto.registerTool;
    if (typeof register === "function") {
      proto.registerTool = function (tool, options) {
        const result = register.call(this, tool, options);
        remember(tool, options && options.signal);
        return result;
      };
    }
    const unregister = proto.unregisterTool;
    if (typeof unregister === "function") {
      proto.unregisterTool = function (name) {
        const result = unregister.call(this, name);
        if (tools.delete(name)) announce();
        return result;
      };
    }
    const provide = proto.provideContext;
    if (typeof provide === "function") {
      proto.provideContext = function (context) {
        const result = provide.call(this, context);
        tools.clear();
        for (const tool of (context && Array.isArray(context.tools) ? context.tools : [])) remember(tool);
        announce();
        return result;
      };
    }
    const clear = proto.clearContext;
    if (typeof clear === "function") {
      proto.clearContext = function () {
        const result = clear.call(this);
        tools.clear();
        announce();
        return result;
      };
    }
  }

  // --- requests from the extension ---
  const client = {
    // The agent is outside the page; nothing to hand over, run the callback.
    requestUserInteraction: (callback) => Promise.resolve().then(callback),
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== "hab-isolated" || data.nonce !== NONCE) return;

    if (data.type === "re-announce") {
      announceNow();
      return;
    }
    if (data.type === "execute-tool") {
      const entry = tools.get(data.name);
      if (!entry) {
        post("tool-result", { callId: data.callId, ok: false, error: `The page has no tool "${data.name}" (any more).` });
        return;
      }
      try {
        const value = await entry.execute(data.args || {}, client);
        let result = plain(value);
        if (result === undefined) result = value === undefined ? null : String(value);
        post("tool-result", { callId: data.callId, ok: true, result });
      } catch (error) {
        const message = error && typeof error.message === "string" && error.message ? error.message : String(error);
        post("tool-result", { callId: data.callId, ok: false, error: message });
      }
    }
  });

  announceNow();
})();
