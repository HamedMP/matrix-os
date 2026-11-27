import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { createHerdrChatTerminalRoute } from "../../packages/gateway/src/chat/herdr-terminal-route.js";
import { MATRIX_MCP_RUN_CONTEXT_KEY, type MatrixMcpRunContext } from "../../packages/gateway/src/chat/matrix-mcp-launch.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, dialMac, gateway, pair, testMac, unpair } from "./fixtures/desktop-link-harness.js";

it("routes a private run to the selected desktop rather than its same-named gateway terminal, fencing reuse and revoke", async () => {
  const home = await mkdtemp(join(tmpdir(), "chat-desktop-"));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const ownCore = createFakeHerdrCore();
  ownCore.add("t7", { title: "compiler", screen: "gateway output" });
  const local = createHerdrAdapter({ open: async () => ownCore.connect() });
  cleanup.push(() => local.close());
  const computer = await gateway();
  const desktop = testMac();
  const macCore = createFakeHerdrCore();
  macCore.add("t7", { title: "compiler", screen: "desktop output" });
  await pair(computer.http, desktop);
  const link = dialMac(computer.base, desktop, { revision: 1, core: macCore, guardHome: home });
  await link.ready();

  const scope = new AbortController();
  let context: MatrixMcpRunContext = { actorId: "owner", runId: "run_example", scope: "chat_herdr_discovery", herdrDiscoverySignal: scope.signal };
  const chat = new Hono();
  chat.use("*", async (c, next) => { c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, context); await next(); });
  chat.route("/", createHerdrChatTerminalRoute(local, createTerminalInputActivity(), computer.registry));
  const call = (body: unknown) => chat.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const search = await call({ action: "discover", query: "compiler" });
  expect(await search.json()).toMatchObject({ total: 2, terminals: [
    { address: "desktop:" + desktop.deviceId + "/t7" }, { address: "gateway/t7" },
  ] });
  expect((await call({ action: "send", text: "node --test" })).status).toBe(403);

  const listUrl = "/api/desktop-link/machines/" + desktop.deviceId + "/terminals?view=chat-control";
  const select = async () => {
    const selection = await (await computer.http(listUrl)).json() as { workspaceId: string; sessions: { tabId: string; revision: string }[] };
    expect(selection.workspaceId).toBe(desktopLinkWorkspaceId(desktop.deviceId));
    const terminal = selection.sessions.find(t => t.tabId === herdrTabId("t7"))!;
    expect(terminal.revision).toMatch(/^[a-f0-9]{64}$/);
    context = { scope: "chat_herdr", actorId: "owner", runId: "run_example", herdr: {
      ref: { workspaceId: selection.workspaceId, tabId: terminal.tabId }, revision: terminal.revision,
      signal: new AbortController().signal, chatId: "chat_12345678901234567890123456789012",
      worktreeId: "wt_1234567890123456", executionRoot: "/cloud/checkout",
    } };
  };
  await select();
  const read = await call({ action: "read", lines: 10 });
  expect(await read.text()).toContain("desktop output");
  expect((await call({ action: "send", text: "node --test" })).status).toBe(200);
  await expect.poll(() => macCore.terminals.get("t7")?.input.join("")).toContain("node --test");
  expect((await call({ action: "interrupt" })).status).toBe(200);
  await expect.poll(() => macCore.terminals.get("t7")?.input.join("")).toContain("\x03");
  expect(ownCore.terminals.get("t7")?.input).toEqual([]);

  macCore.add("t7", { title: "compiler", screen: "replacement" });
  expect((await call({ action: "send", text: "stale" })).status).toBe(409);
  expect(macCore.terminals.get("t7")?.input).toEqual([]);
  await select();
  link.socket.close();
  await link.closed();
  const reconnected = dialMac(computer.base, desktop, { revision: 1, core: macCore, guardHome: home });
  await reconnected.ready();
  // The link admits first. Its Herdr adapter briefly backs off after losing the old stream.
  await expect.poll(async () => (await computer.http(listUrl)).status, { timeout: 4000 }).toBe(200);
  expect((await call({ action: "send", text: "previous connection" })).status).toBe(409);
  expect(macCore.terminals.get("t7")?.input).toEqual([]);
  await select();
  // A pairing can be revoked by another Gateway process while this WebSocket still looks online.
  computer.registry!.usePairing(async () => ({ deviceId: null, revision: 2 }));
  expect((await computer.http(listUrl)).status).toBe(503);
  await unpair(computer.http, desktop, 1);
  expect((await call({ action: "read", lines: 10 })).status).toBe(409);
  expect((await call({ action: "send", text: "disconnected" })).status).toBe(409);
  expect(ownCore.terminals.get("t7")?.input).toEqual([]);
});
