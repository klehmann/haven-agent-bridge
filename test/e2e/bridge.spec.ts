/**
 * End to end: Chromium with the extension, two test pages on different
 * origins that register the same tool names, the daemon, and MCP clients
 * over Streamable HTTP and over the stdio shim.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from "@playwright/test";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const HOME = mkdtempSync(join(tmpdir(), "hab-e2e-"));
// A copy of the extension that only looks at a test port, so the tests never
// touch a bridge the developer is running on 13300-13309 at the same time.
const TEST_PORT = 13390;
const EXTENSION = join(HOME, "extension");
cpSync(join(ROOT, "extension"), EXTENSION, { recursive: true });
writeFileSync(
  join(EXTENSION, "background.js"),
  readFileSync(join(EXTENSION, "background.js"), "utf8")
    .replace(/const PORT_FIRST = \d+;/, `const PORT_FIRST = ${TEST_PORT};`)
    .replace(/const PORT_LAST = \d+;/, `const PORT_LAST = ${TEST_PORT};`),
);
const ORIGIN_A = "http://127.0.0.1:4601";
const ORIGIN_B = "http://localhost:4602";

let daemon: ChildProcess;
let servers: Server[] = [];
let context: BrowserContext;
let worker: Worker;
let port: number;
let token: string;

function serve(listenPort: number, host: string): Promise<Server> {
  const html = readFileSync(join(ROOT, "test/fixtures/page.html"));
  return new Promise((done) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
    }).listen(listenPort, host, () => done(server));
  });
}

async function waitFor<T>(fn: () => Promise<T | null | undefined> | T | null | undefined, what: string, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function state() {
  const res = await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { "x-bridge-token": token } });
  return (await res.json()) as {
    extension: { connected: boolean };
    targets: Array<{ tabId: number; origin: string; tools: Array<{ name: string }> }>;
    sessions: Array<{ id: string; client: string }>;
    defaultTabId: number | null;
  };
}

async function httpClient(name: string) {
  const client = new Client({ name, version: "1.0.0" });
  const changes: number[] = [];
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changes.push(Date.now());
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  return { client, changes };
}

function originOfTools(tools: Array<{ name: string; _meta?: Record<string, unknown> }>) {
  return [...new Set(tools.filter((t) => !t.name.startsWith("bridge_")).map((t) => t._meta?.["webmcp/origin"]))];
}

async function openPage(url: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(url);
  await page.bringToFront();
  return page;
}

test.beforeAll(async () => {
  servers = [await serve(4601, "127.0.0.1"), await serve(4602, "127.0.0.1")];
  daemon = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "daemon", "--record", "--quiet", "--port", String(TEST_PORT)], {
    env: { ...process.env, HAVEN_AGENT_BRIDGE_HOME: HOME },
    stdio: "inherit",
  });
  port = await waitFor(() => {
    try {
      return Number(readFileSync(join(HOME, "port"), "utf8"));
    } catch {
      return null;
    }
  }, "daemon port");
  token = readFileSync(join(HOME, "token"), "utf8").trim();

  context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  await worker.evaluate((origins) => (globalThis as any).havenAgentBridge.setOrigins(origins), [ORIGIN_A, ORIGIN_B]);
  await waitFor(async () => (await state()).extension.connected, "extension connection");
});

test.afterAll(async () => {
  await context?.close();
  daemon?.kill("SIGTERM");
  for (const s of servers) s.close();
});

test("one tab per client, list_changed on tab switch and app focus, origin-bound calls", async () => {
  const pageA = await openPage(`${ORIGIN_A}/`);
  await waitFor(async () => (await state()).targets.find((t) => t.origin === ORIGIN_A)?.tools.length, "tab A tools");
  const pageB = await openPage(`${ORIGIN_B}/`);
  await waitFor(async () => (await state()).targets.find((t) => t.origin === ORIGIN_B)?.tools.length, "tab B tools");

  const { client, changes } = await httpClient("e2e-http");

  // Same tool names in two tabs: the client sees one set, from the tab used last (B).
  let tools = (await client.listTools()).tools;
  expect(tools.filter((t) => t.name === "demo_echo")).toHaveLength(1);
  expect(originOfTools(tools)).toEqual([ORIGIN_B]);
  expect(tools.find((t) => t.name === "demo_echo")?.annotations).toEqual({ readOnlyHint: true });

  let result = await client.callTool({ name: "demo_echo", arguments: { text: "hi" } });
  expect(result.structuredContent).toEqual({ origin: ORIGIN_B, app: null, text: "hi" });

  // Switching to tab A: list_changed, then A's tools.
  await pageA.bringToFront();
  await waitFor(() => changes.length >= 1, "list_changed after tab switch");
  tools = (await client.listTools()).tools;
  expect(originOfTools(tools)).toEqual([ORIGIN_A]);
  result = await client.callTool({ name: "demo_echo", arguments: { text: "a" } });
  expect((result.structuredContent as { origin: string }).origin).toBe(ORIGIN_A);
  expect(await pageB.evaluate(() => (window as any).calls.length)).toBe(1);

  // The page swaps its tools (Haven focusing an app): list_changed again.
  const before = changes.length;
  await pageA.evaluate(() => (window as any).focusApp("todo"));
  await waitFor(() => changes.length > before, "list_changed after app focus");
  tools = (await client.listTools()).tools;
  expect(tools.map((t) => t.name)).toContain("todo_list");
  expect(tools.find((t) => t.name === "todo_list")?.annotations).toEqual({ readOnlyHint: true, openWorldHint: true });

  // A page that returns MCP content (an image) reaches the client unchanged.
  result = await client.callTool({ name: "demo_image", arguments: {} });
  expect(result.isError).toBeFalsy();
  expect(result.content).toEqual([
    { type: "text", text: "1x1 red pixel" },
    expect.objectContaining({ type: "image", mimeType: "image/png", data: expect.stringMatching(/^iVBOR/) }),
  ]);

  // Haven-style errors arrive as isError with the payload as structuredContent.
  result = await client.callTool({ name: "demo_locked", arguments: {} });
  expect(result.isError).toBe(true);
  expect((result.structuredContent as { error: string }).error).toBe("LOCKED");

  // Pin the client to tab A; tab A navigates to B's origin: no tools, calls are refused.
  const s = await state();
  const session = s.sessions.find((x) => x.client.startsWith("e2e-http"))!;
  const tabA = s.targets.find((t) => t.origin === ORIGIN_A)!;
  await fetch(`http://127.0.0.1:${port}/api/sessions/${session.id}/selection`, {
    method: "POST",
    headers: { "x-bridge-token": token, "content-type": "application/json" },
    body: JSON.stringify({ selection: { mode: "tab", tabId: tabA.tabId, origin: ORIGIN_A } }),
  });
  await pageA.goto(`${ORIGIN_B}/`);
  await waitFor(async () => (await state()).targets.filter((t) => t.origin === ORIGIN_B).length === 2, "tab A on origin B");
  result = await client.callTool({ name: "demo_echo", arguments: { text: "x" } });
  expect(result.isError).toBe(true);
  expect((result.structuredContent as { error: string }).error).toBe("STATE_CHANGED");
  expect((await client.listTools()).tools.every((t) => t.name.startsWith("bridge_"))).toBe(true);

  await client.close();
});

test("calls stay in the tab, document and tool version the client listed", async () => {
  const pageA = await openPage(`${ORIGIN_A}/`);
  await waitFor(async () => (await state()).targets.find((t) => t.origin === ORIGIN_A && t.tools.length), "tab A tools");
  const { client, changes } = await httpClient("e2e-binding");
  expect(originOfTools((await client.listTools()).tools)).toEqual([ORIGIN_A]);

  // The user switches to a tab on another origin before the agent re-lists:
  // the agent's next call still goes to the tab it listed.
  const pageB = await openPage(`${ORIGIN_B}/`);
  await waitFor(() => changes.length >= 1, "list_changed after tab switch");
  let result = await client.callTool({ name: "demo_echo", arguments: { text: "bound" } });
  expect((result.structuredContent as { origin: string }).origin).toBe(ORIGIN_A);
  expect(await pageB.evaluate(() => (window as any).calls.length)).toBe(0);

  // After listing again it follows the switch.
  expect(originOfTools((await client.listTools()).tools)).toEqual([ORIGIN_B]);
  result = await client.callTool({ name: "demo_echo", arguments: { text: "b" } });
  expect((result.structuredContent as { origin: string }).origin).toBe(ORIGIN_B);

  // The listed page reloads (same origin, same tools): refused until listed again.
  const listed = await state();
  const tabB = listed.targets.find((t) => t.tabId === listed.defaultTabId) as { tabId: number; documentId?: string };
  expect(tabB.documentId).toBeTruthy();
  await pageB.reload();
  await waitFor(async () => {
    const t = (await state()).targets.find((x) => x.tabId === tabB.tabId) as { tools: unknown[]; documentId?: string } | undefined;
    return t && t.tools.length && t.documentId !== tabB.documentId;
  }, "tab B reloaded");
  result = await client.callTool({ name: "demo_echo", arguments: { text: "stale" } });
  expect(result.structuredContent).toMatchObject({ error: "STATE_CHANGED" });
  expect(JSON.stringify(result.content)).toContain("reloaded");

  // A tool whose definition changed after listing is refused too.
  await client.listTools();
  await pageB.evaluate(() => (window as any).focusApp("todo")); // same names, new set
  await waitFor(async () => (await state()).targets.find((t) => t.tabId === tabB.tabId)?.tools.some((t) => t.name === "todo_list"), "re-registration");
  result = await client.callTool({ name: "todo_list", arguments: {} });
  expect(result.structuredContent).toMatchObject({ error: "STATE_CHANGED" });

  await client.close();
  await pageA.close();
});

test("stdio shim reaches the same daemon", async () => {
  await openPage(`${ORIGIN_A}/`);
  await waitFor(async () => (await state()).targets.find((t) => t.origin === ORIGIN_A)?.tools.length, "tab A tools");
  const client = new Client({ name: "e2e-stdio", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "dist/cli.js")],
      env: { ...(process.env as Record<string, string>), HAVEN_AGENT_BRIDGE_HOME: HOME },
    }),
  );
  const { tools } = await client.listTools();
  expect(tools.map((t) => t.name)).toContain("demo_echo");
  const status = await client.callTool({ name: "bridge_status", arguments: {} });
  expect((status.structuredContent as { browserConnected: boolean }).browserConnected).toBe(true);
  const result = await client.callTool({ name: "demo_echo", arguments: { text: "stdio" } });
  expect((result.structuredContent as { text: string }).text).toBe("stdio");
  await client.close();
});

test("debug GUI shows tabs, tools and the call log", async () => {
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`http://127.0.0.1:${port}/ui#token=${token}`);
  await expect(page.locator("#status")).toContainText("Browser connected");
  await expect(page.locator("#log-body")).toContainText("demo_echo");
  await page.locator("#log-body tr.row", { hasText: "demo_echo" }).first().click();
  await expect(page.locator("#log-body .detail")).toContainText("Arguments");
  await page.screenshot({ path: join(ROOT, "test-results/gui-calls.png") });

  await page.getByRole("tab", { name: "Tools" }).click();
  await expect(page.locator("#tools-list")).toContainText("demo_echo");
  await page.screenshot({ path: join(ROOT, "test-results/gui-tools.png") });

  await page.getByRole("tab", { name: "Statistics" }).click();
  await expect(page.locator("#stats-tools")).toContainText("demo_echo");
  await page.screenshot({ path: join(ROOT, "test-results/gui-stats.png") });

  await page.getByRole("tab", { name: "Tabs & clients" }).click();
  await expect(page.locator("#targets-body")).toContainText("Bridge test page");
  await page.screenshot({ path: join(ROOT, "test-results/gui-targets.png") });

  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("tab", { name: "Calls" }).click();
  await page.locator("#log-body tr.row", { has: page.locator(".status.error") }).first().click();
  await page.screenshot({ path: join(ROOT, "test-results/gui-calls-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });

  const exported = await (
    await fetch(`http://127.0.0.1:${port}/api/export?format=json&redact=1`, { headers: { "x-bridge-token": token } })
  ).json();
  expect(exported.redacted).toBe(true);
  expect(exported.entries.some((e: { kind: string; args?: string }) => e.kind === "call" && e.args?.startsWith("[redacted"))).toBe(true);
});

test("web pages cannot read the token or call the API", async () => {
  const page = await openPage(`${ORIGIN_A}/`);
  const outcome = await page.evaluate(async (p) => {
    const results: string[] = [];
    for (const path of ["/.well-known/haven-agent-bridge", "/api/state"]) {
      try {
        const res = await fetch(`http://127.0.0.1:${p}${path}`, { mode: "no-cors" });
        results.push(`${path}:${res.type}`);
      } catch (error) {
        results.push(`${path}:failed`);
      }
    }
    return results;
  }, port);
  // An opaque or failed response: the page learns nothing.
  for (const line of outcome) expect(line).toMatch(/:(opaque|failed)$/);
  const direct = await fetch(`http://127.0.0.1:${port}/.well-known/haven-agent-bridge`, { headers: { origin: ORIGIN_A } });
  expect(direct.status).toBe(403);
});

test("a call in flight when the daemon dies is reported as unknown, never re-sent", async () => {
  const page = await openPage(`${ORIGIN_A}/`);
  await waitFor(async () => (await state()).targets.find((t) => t.origin === ORIGIN_A && t.tools.length), "tab A tools");
  const client = new Client({ name: "e2e-crash", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, "dist/cli.js")],
      env: { ...(process.env as Record<string, string>), HAVEN_AGENT_BRIDGE_HOME: HOME },
    }),
  );
  await client.listTools();
  const call = client.callTool({ name: "demo_slow", arguments: { ms: 1500 } }).then(
    (r) => ({ ok: true as const, r }),
    (e: Error) => ({ ok: false as const, message: e.message }),
  );
  await new Promise((r) => setTimeout(r, 300));
  daemon.kill("SIGKILL");
  const outcome = await call;
  expect(outcome.ok).toBe(false);
  expect(outcome.ok ? "" : outcome.message).toContain("may or may not have run");
  await new Promise((r) => setTimeout(r, 2000));
  // The page ran it once; nothing was replayed.
  expect(await page.evaluate(() => (window as any).writes)).toBe(1);
  await client.close();
  // The shim may have started a replacement daemon; stop it.
  try {
    process.kill(Number(readFileSync(join(HOME, "daemon.lock"), "utf8")), "SIGTERM");
  } catch {
    // none started
  }
});
