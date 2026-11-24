// Terminals on a linked desktop (spec 2716 layer 4): the owner lists, starts,
// reads, types into and ends them over HTTP, and watches them on the viewer
// socket. The desktop stand-in pipes through the real desktop-side guard.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { registerDesktopLinkTerminalSocket } from "../../packages/gateway/src/desktop-link/terminal-routes.js";
import { requireRequestPrincipal } from "../../packages/gateway/src/request-principal.js";
import { createTerminalLiveOwnership } from "../../packages/gateway/src/terminal-live-ownership.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { runCommand } from "citty";
import { createMachineClient, shellMachineCommand } from "../../packages/sync-client/src/cli/commands/shell-machine.js";
import { cleanup, dialMac, enrol, gateway, LOCAL_TOKEN, OWNER, ownerHeaders, testMac } from "./fixtures/desktop-link-harness.js";

async function linkedMac() {
  const home = mkdtempSync(join(tmpdir(), "desktop-home-"));
  mkdirSync(join(home, "projects"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const registry = createDesktopLinkRegistry({
    createAdapter: (open) => createHerdrAdapter({ open, captureQuietMs: 5, captureMaxMs: 150 }),
  });
  const ownership = createTerminalLiveOwnership();
  cleanup.push(() => ownership.close());
  const computer = await gateway({
    registry,
    extend: (app, upgradeWebSocket, links) => {
      const viewers = registerDesktopLinkTerminalSocket({
        app, upgradeWebSocket, registry: links, getPrincipal: requireRequestPrincipal, terminalOwnerIds: [OWNER],
        terminalLiveOwnership: ownership,
      });
      cleanup.push(() => viewers.drain());
    },
  });
  const core = createFakeHerdrCore();
  const mac = testMac();
  await enrol(computer.http, mac);
  const link = dialMac(computer.base, mac, { revision: 1, core, guardHome: home });
  await link.ready();
  const path = `/api/desktop-link/machines/${mac.deviceId}/terminals`;
  return { ...computer, core, mac, link, path, home };
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("desktop terminals over HTTP", () => {
  it("starts a shell and an agent preset, lists them, reads and types, then ends one", async () => {
    const { http, core, path, mac } = await linkedMac();
    const shell = await http(path, json({ cwd: "projects", name: "build" }));
    expect(shell.status).toBe(201);
    const { id, workspaceId, tabId } = await shell.json() as { id: string; workspaceId: string; tabId: string };
    expect(workspaceId).toBe(desktopLinkWorkspaceId(mac.deviceId));
    const agent = await http(path, json({ agent: "codex" }));
    expect(agent.status).toBe(201);

    const runs = core.calls.filter((call) => call.method === "terminal.run").map((call) => call.params);
    // The guard resolved the folder under the desktop's home and labelled both as started by the computer.
    expect(runs[0]).toMatchObject({ name: "build", labels: { "matrix.from": "matrix-demo" } });
    expect(String(runs[0]!.cwd)).toMatch(/projects$/);
    expect(runs[1]).toMatchObject({ line: "codex --no-daemon" });

    const listed = await (await http(path)).json() as { workspaceId: string; sessions: Array<{ id: string; tabId: string }> };
    expect(listed.sessions.map((session) => session.id)).toEqual(expect.arrayContaining([id]));
    // The ref returned at start is the one the listing reports, so a view can open it at once.
    expect(listed.sessions.find((session) => session.id === id)?.tabId).toBe(tabId);
    expect(listed.workspaceId).toBe(desktopLinkWorkspaceId(mac.deviceId));

    const screen = await http(`${path}/${id}/screen?lines=50`);
    expect(screen.status).toBe(200);
    expect(JSON.stringify(await screen.json())).toContain("ran build");

    expect((await http(`${path}/${id}/input`, json({ data: "ls\r" }))).status).toBe(200);
    await expect.poll(() => core.terminals.get(id)?.input.join("")).toContain("ls\r");

    expect((await http(`${path}/${id}`, { method: "DELETE" })).status).toBe(200);
    expect(core.terminals.has(id)).toBe(false);
  });

  it("refuses what the desktop's guard refuses, and bad requests at the boundary", async () => {
    const { http, path, core } = await linkedMac();
    const outside = await http(path, json({ cwd: "/etc" }));
    expect(outside.status).toBe(403);
    expect(core.calls.some((call) => call.method === "terminal.run")).toBe(false);
    expect((await http(path, json({ agent: "claude", argv: ["sh"] }))).status).toBe(400);
    expect((await http(path, json({ argv: [] }))).status).toBe(400);
    expect((await http(`${path}/not-an-id/screen`)).status).toBe(400);
    expect((await http(`/api/desktop-link/machines/zz/terminals`)).status).toBe(400);
  });

  it("limits how fast the computer starts terminals on one desktop", async () => {
    const { http, path } = await linkedMac();
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) statuses.push((await http(path, json({}))).status);
    expect(statuses.slice(0, 10).every((status) => status === 201)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it("answers desktop_offline once the desktop is gone, and refuses an org member", async () => {
    const { http, path, link } = await linkedMac();
    expect((await http(path, {}, ownerHeaders("org_member"))).status).toBe(403);
    link.socket.terminate();
    await expect.poll(async () => (await http(path)).status).toBe(503);
    expect(await (await http(path)).json()).toEqual({ error: "desktop_offline" });
  });
});

describe("Agents on the computer", () => {
  it("reach desktop terminals with the local terminal token, but cannot enrol, remove or link a desktop", async () => {
    const { http, path, mac, base } = await linkedMac();
    const local = { authorization: `Bearer ${LOCAL_TOKEN}` };
    expect((await http("/api/desktop-link/machines", {}, local)).status).toBe(200);
    const started = await http(path, json({ argv: ["uname", "-s"] }), local);
    expect(started.status).toBe(201);
    const { id } = await started.json() as { id: string };
    expect((await http(`${path}/${id}/screen`, {}, local)).status).toBe(200);
    expect((await http(`${path}/${id}/input`, json({ data: "x" }), local)).status).toBe(200);
    expect((await http(`${path}/${id}`, { method: "DELETE" }, local)).status).toBe(200);

    expect((await http("/api/desktop-link/enrol/challenge", json({ deviceId: mac.deviceId }), local)).status).toBe(401);
    expect((await http(`/api/desktop-link/machines/${mac.deviceId}`, { method: "DELETE" }, local)).status).toBe(401);
    // Through a proxy it is not a local caller.
    expect((await http(path, {}, { ...local, "x-forwarded-for": "1.2.3.4" })).status).toBe(401);
    const link = dialMac(base, testMac(), { revision: 1, headers: local });
    await link.closed();
    expect(link.upgradeStatus()).toBe(401);
  });
});

describe("matrix shell machine", () => {
  it("lets an agent start, read, type into and end a desktop terminal by the desktop's name", async () => {
    const { base, core } = await linkedMac();
    const client = createMachineClient({ gatewayUrl: `http://${base}`, token: LOCAL_TOKEN });
    const machine = await client.resolve("hamed's macbook");
    const started = await client.run(machine.deviceId, { argv: ["uname", "-s"] });
    const id = String(started.id);
    expect(core.calls.find((call) => call.method === "terminal.run")?.params).toMatchObject({ argv: ["uname", "-s"] });
    expect(JSON.stringify(await client.read(machine.deviceId, id, 10))).toContain("ran uname");
    await client.input(machine.deviceId, id, "echo hi\r");
    await expect.poll(() => core.terminals.get(id)?.input.join("")).toContain("echo hi");
    await client.kill(machine.deviceId, id);
    await expect(client.resolve("no-such-mac")).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("passes the program after -- and reports a refused folder as denied", async () => {
    const { base, core } = await linkedMac();
    const output: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { output.push(String(line)); });
    const error = vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    cleanup.push(() => { log.mockRestore(); error.mockRestore(); process.exitCode = 0; });
    const flags = ["--gateway", `http://${base}`, "--token", LOCAL_TOKEN, "--json"];
    await runCommand(shellMachineCommand, { rawArgs: ["run", "Hamed's MacBook", ...flags, "--", "uname", "-s"] });
    expect(core.calls.find((call) => call.method === "terminal.run")?.params).toMatchObject({ argv: ["uname", "-s"] });
    expect(JSON.parse(output.at(-1)!)).toMatchObject({ ok: true, data: { machine: "Hamed's MacBook" } });
    await runCommand(shellMachineCommand, { rawArgs: ["run", "Hamed's MacBook", ...flags, "--cwd", "/etc"] });
    expect(errors.at(-1)).toContain("denied");
  });
});

describe("desktop terminal viewer socket", () => {
  it("attaches the owner to a desktop terminal and streams its output", async () => {
    const { http, base, path, core, mac } = await linkedMac();
    const { id } = await (await http(path, json({ name: "watch" }))).json() as { id: string };
    const socket = new WebSocket(`ws://${base}/ws/desktop-link/terminal?workspaceId=${desktopLinkWorkspaceId(mac.deviceId)}&id=${id}`, { headers: ownerHeaders() });
    cleanup.push(() => socket.terminate());
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
    await expect.poll(() => frames.some((frame) => frame.type === "attached")).toBe(true);
    // Frames carry the desktop's own workspace, so refs from two desktops never collide.
    expect(frames.find((frame) => frame.type === "attached")?.terminalRef).toMatchObject({ workspaceId: desktopLinkWorkspaceId(mac.deviceId) });
    core.output(id, "hello from the desktop");
    await expect.poll(() => frames.filter((frame) => frame.type === "output").map((frame) => frame.data).join("")).toContain("hello from the desktop");
  });

  it("refuses a viewer naming no desktop, an unlinked desktop, or another person", async () => {
    const { http, base, path, mac } = await linkedMac();
    const { id } = await (await http(path, json({}))).json() as { id: string };
    const attempts = [
      { query: `id=${id}`, headers: ownerHeaders() },
      { query: `workspaceId=${desktopLinkWorkspaceId("0".repeat(64))}&id=${id}`, headers: ownerHeaders() },
      // Herdr's own workspace is not a desktop.
      { query: `workspaceId=tws_00000000000000000000006865726472&id=${id}`, headers: ownerHeaders() },
      { query: `workspaceId=${desktopLinkWorkspaceId(mac.deviceId)}&id=${id}`, headers: ownerHeaders("org_member") },
    ];
    for (const attempt of attempts) {
      const socket = new WebSocket(`ws://${base}/ws/desktop-link/terminal?${attempt.query}`, { headers: attempt.headers });
      cleanup.push(() => socket.terminate());
      const frames: Array<Record<string, unknown>> = [];
      socket.on("message", (data) => frames.push(JSON.parse(String(data)) as Record<string, unknown>));
      socket.on("error", () => {});
      await expect.poll(() => socket.readyState === WebSocket.CLOSED).toBe(true);
      expect(frames.some((frame) => frame.type === "attached")).toBe(false);
    }
  });
});
