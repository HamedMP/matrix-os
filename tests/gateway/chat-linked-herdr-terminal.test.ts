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
import { createDesktopLinkConsent, type DesktopLinkConsentRequest } from "../../desktop/src/main/desktop-link/consent";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, dialMac, gateway, ownerHeaders, pair, testMac, unpair } from "./fixtures/desktop-link-harness.js";

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

it("discovers and uses only the explicitly approved terminal on a paired Mac's enrolled SSH machine", async () => {
  const computer = await gateway();
  const desktop = testMac();
  const core = createFakeHerdrCore();
  core.machines.set("devstack-hel1", { id: "a".repeat(32), state: "connected" });
  core.add("devstack-hel1/t2", { title: "HEL1 test checkout", screen: "HEL1-READ", identity: { pid: 42, created_ms: 123, cwd: "/home/guest/worktree" } });
  core.add("t2", { title: "Mac test checkout", screen: "MAC-READ" });
  const prompts: DesktopLinkConsentRequest[] = [];
  const consent = createDesktopLinkConsent({
    ask: async request => { prompts.push(request); return prompts.length === 1; },
    fullAccess: async () => true,
    dialogGapMs: 0,
  });
  await pair(computer.http, desktop);
  const link = dialMac(computer.base, desktop, { revision: 1, core, consent, guardHome: tmpdir() });
  await link.ready();
  const url = "/api/desktop-link/machines/" + desktop.deviceId + "/terminals";
  expect((await computer.http(url + "?view=chat-control", {}, ownerHeaders("another-owner"))).status).toBe(403);
  expect(await (await computer.http(url)).json()).toMatchObject({ sessions: [{ id: "t2", title: "Mac test checkout" }] });
  const picked = await (await computer.http(url + "?view=chat-control")).json() as {
    workspaceId: string; sessions: Array<{ machine?: string; id: string; tabId: string; revision: string }>;
  };
  const remote = picked.sessions.find(row => row.machine === "devstack-hel1")!;
  expect(remote).toMatchObject({ id: "t2", tabId: herdrTabId("devstack-hel1/t2"), revision: expect.stringMatching(/^[0-9a-f]{64}$/) });
  const scope = new AbortController();
  let context: MatrixMcpRunContext = { actorId: "owner", runId: "run_enrolled", scope: "chat_herdr_discovery", herdrDiscoverySignal: scope.signal };
  const chat = new Hono();
  chat.use("*", async (c, next) => { c.set(MATRIX_MCP_RUN_CONTEXT_KEY as never, context); await next(); });
  chat.route("/", createHerdrChatTerminalRoute(null, createTerminalInputActivity(), computer.registry));
  const call = (body: unknown) => chat.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const address = "desktop:" + desktop.deviceId + "/machine:devstack-hel1";
  expect(await (await call({ action: "discover", machine: address })).json()).toMatchObject({ terminals: [{ address: address + "/t2" }] });
  const select = () => {
    context = { scope: "chat_herdr", actorId: "owner", runId: "run_enrolled", herdr: {
      ref: { workspaceId: picked.workspaceId, tabId: remote.tabId }, revision: remote.revision,
      signal: new AbortController().signal, chatId: "chat_12345678901234567890123456789012",
      worktreeId: "wt_1234567890123456", executionRoot: "/cloud/checkout",
    } };
  };
  select();
  expect(await (await call({ action: "read", lines: 10 })).text()).toContain("HEL1-READ");
  expect((await call({ action: "send", text: "hostname" })).status).toBe(200);
  await expect.poll(() => core.terminals.get("devstack-hel1/t2")?.input).toEqual(["hostname\r"]);
  expect(core.terminals.get("t2")?.input).toEqual([]);
  expect(prompts).toMatchObject([{ kind: "remote-terminal", terminal: "devstack-hel1/t2" }]);
  select();
  const denied = await call({ action: "send", text: "blocked by the owner's second decision" });
  expect(denied.status).toBe(409);
  expect(prompts).toHaveLength(2);
  const route = core.machines.get("devstack-hel1")!;
  route.state = "unreachable";
  select();
  expect((await call({ action: "send", text: "offline" })).status).toBe(409);
  route.state = "connected";
  route.id = "b".repeat(32);
  select();
  expect((await call({ action: "send", text: "replacement machine" })).status).toBe(409);
  await unpair(computer.http, desktop, 1);
  expect((await call({ action: "read", lines: 10 })).status).toBe(409);
  expect(prompts).toHaveLength(2);
  expect(core.terminals.get("devstack-hel1/t2")?.input).toEqual(["hostname\r"]);
});
