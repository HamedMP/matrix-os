// Chat and agents driving a linked desktop (spec 2716): desktop terminals join the
// 2692 terminal pipeline under the desktop's own workspace id, so terminal_list,
// read, keys, interrupt and wait reach them; the kernel can list the desktop and
// start terminals there; and the desktop routes press keys, interrupt and wait.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { describe, expect, it, vi } from "vitest";
import { desktopLinkWorkspaceId } from "@matrix-os/contracts/desktop-link";
import { terminalAgentToolDefinitions, type TerminalAgentKernelTools } from "../../packages/kernel/src/tools/terminal-agents.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { desktopKernelTools } from "../../packages/gateway/src/desktop-link/kernel-tools.js";
import { createDesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { DESKTOP_LISTING_DEADLINE_MS, withDesktopTerminals } from "../../packages/gateway/src/desktop-link/verb-runtime.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";
import { createTerminalAgentStatusSource } from "../../packages/gateway/src/terminal-agent/status-source.js";
import { createTerminalAgentVerbs } from "../../packages/gateway/src/terminal-agent/verbs.js";
import { createTerminalWaiter } from "../../packages/gateway/src/terminal-agent/wait.js";
import { createTerminalAgentServices } from "../../packages/gateway/src/terminal-agent/services.js";
import { createTerminalWorkspaceProjectAdmission } from "../../packages/gateway/src/shell/workspace-routes.js";
import { openPageArgv, shellMachineCommand } from "../../packages/sync-client/src/cli/commands/shell-machine.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";
import { cleanup, dialMac, gateway, pair, LOCAL_TOKEN, testMac } from "./fixtures/desktop-link-harness.js";

/** The Matrix runtime with no tabs of its own: only the desktop's terminals are in play. */
const emptyRuntime = {
  listWorkspaces: async () => [],
  getSnapshot: async () => undefined,
  captureScreen: async () => null,
  writeInput: async () => { throw new Error("not a Matrix tab"); },
  listAgentStatuses: async () => [],
};

async function linkedMac() {
  const home = mkdtempSync(join(tmpdir(), "desktop-home-"));
  mkdirSync(join(home, "projects"));
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  const registry = createDesktopLinkRegistry({
    createAdapter: (open) => createHerdrAdapter({ open, captureQuietMs: 5, captureMaxMs: 150 }),
  });
  const pipeline = withDesktopTerminals(emptyRuntime, registry);
  const status = createTerminalAgentStatusSource({ runtime: pipeline });
  const verbs = createTerminalAgentVerbs({ runtime: pipeline, inputActivity: createTerminalInputActivity(), quietMs: 5 });
  const waiter = createTerminalWaiter({ runtime: pipeline, status, pollMs: 20 });
  cleanup.push(() => waiter.shutdown());
  const computer = await gateway({ registry, verbs, waiter });
  const core = createFakeHerdrCore();
  core.add("t1", { title: "claude on the desktop", status: { state: "working" }, screen: "thinking…" });
  const mac = testMac();
  await pair(computer.http, mac);
  const link = dialMac(computer.base, mac, { revision: 1, core, guardHome: home });
  await link.ready();
  const ref = { workspaceId: desktopLinkWorkspaceId(mac.deviceId), tabId: herdrTabId("t1") };
  return { ...computer, registry, pipeline, verbs, core, mac, link, ref, path: `/api/desktop-link/machines/${mac.deviceId}/terminals` };
}

const json = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

describe("desktop terminals in the terminal pipeline", () => {
  it("lists a linked desktop's terminals under the desktop's own workspace, and reads and types there", async () => {
    const { pipeline, verbs, core, ref } = await linkedMac();
    const workspaces = await pipeline.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]!.id).toBe(ref.workspaceId);
    expect(workspaces[0]!.tabs.map((tab) => [tab.id, tab.workspaceId])).toEqual([[ref.tabId, ref.workspaceId]]);
    expect(JSON.stringify(await verbs.read(ref, { lines: 10 }))).toContain("thinking");
    await verbs.keys(ref, { keys: ["enter"] });
    await expect.poll(() => core.terminals.get("t1")?.input.join("")).toContain("\r");
    const statuses = await pipeline.listAgentStatuses();
    expect(statuses.map((entry) => entry.ref)).toEqual([ref]);
  });

  // Fault detected (review): a half-open link, or a desktop waiting on its owner, held
  // the computer's own terminal listing (terminal_list, matrix shell list) for up to 75 s.
  it("lists this computer's own terminals within a few seconds even when a desktop never answers", async () => {
    vi.useFakeTimers();
    try {
      const own = { id: "tws_" + "1".repeat(32), tabs: [] } as never;
      const stuck = { workspace: () => new Promise(() => {}), statuses: () => new Promise(() => {}) };
      const pipeline = withDesktopTerminals(
        { ...emptyRuntime, listWorkspaces: async () => [own], listAgentStatuses: async () => [{ ref: { workspaceId: "w", tabId: "t" } } as never] },
        { linked: () => [{ deviceId: "a5".repeat(32), name: "Studio", adapter: stuck as never }] } as never,
      );
      const workspaces = pipeline.listWorkspaces();
      const statuses = pipeline.listAgentStatuses();
      await vi.advanceTimersByTimeAsync(DESKTOP_LISTING_DEADLINE_MS);
      expect(await workspaces).toEqual([own]);
      expect(await statuses).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a linked desktop's terminals reachable while this computer's terminal runtime is down", async () => {
    const { registry, core, ref } = await linkedMac();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const down = { ...emptyRuntime, listWorkspaces: async () => { throw new Error("connect EACCES /run/matrix/terminal-runtime.sock"); } };
    const pipeline = withDesktopTerminals(down, registry);
    expect((await pipeline.listWorkspaces()).map((workspace) => workspace.id)).toEqual([ref.workspaceId]);
    const verbs = createTerminalAgentVerbs({ runtime: pipeline, inputActivity: createTerminalInputActivity(), quietMs: 5 });
    await verbs.keys(ref, { keys: ["enter"] });
    await expect.poll(() => core.terminals.get("t1")?.input.join("")).toContain("\r");
    // With no desktop linked, the runtime's failure is still the answer.
    await expect(withDesktopTerminals(down, { linked: () => [] }).listWorkspaces()).rejects.toThrow("EACCES");
  });

  // Fault detected (review): one failed status read on this computer dropped the desktops'
  // statuses too, so terminal_wait and interrupt worked from stale or empty statuses.
  it("keeps a linked desktop's agent statuses while this computer's status read fails", async () => {
    const { registry, core, ref } = await linkedMac();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    core.terminals.get("t1")!.status = { state: "working", msg: "thinking" };
    const down = { ...emptyRuntime, listAgentStatuses: async () => { throw new Error("connect EACCES /run/matrix/terminal-runtime.sock"); } };
    const statuses = await withDesktopTerminals(down, registry).listAgentStatuses!();
    expect(statuses.some((entry) => entry.ref.workspaceId === ref.workspaceId)).toBe(true);
  });

  it("finds nothing for a desktop that is not linked, and drops its terminals when it goes", async () => {
    const { pipeline, link, ref } = await linkedMac();
    await expect(pipeline.writeInput({ ...ref, workspaceId: desktopLinkWorkspaceId("0".repeat(64)) }, "x")).rejects.toMatchObject({ code: "not_found" });
    link.socket.terminate();
    await expect.poll(async () => (await pipeline.listWorkspaces()).length).toBe(0);
  });
});

describe("The gateway's terminal services with a linked desktop", () => {
  it("shows the desktop's terminals in terminal_list with the desktop's name, and the kernel types there as the owner", async () => {
    const { registry, core, ref } = await linkedMac();
    const home = mkdtempSync(join(tmpdir(), "desktop-services-"));
    cleanup.push(() => rmSync(home, { recursive: true, force: true }));
    const runtime = { listWorkspaces: async () => [], getSnapshot: async () => undefined, writeInput: vi.fn(async () => undefined), listAgentStatuses: async () => [] };
    const services = createTerminalAgentServices({
      runtime: runtime as never, homePath: home, terminalOwnerIds: ["owner_mac"],
      projectAdmission: createTerminalWorkspaceProjectAdmission({ runtime }), desktopLinks: registry,
    });
    cleanup.push(() => services.close());
    expect(await services.kernelTools.list()).toEqual([{
      workspaceId: ref.workspaceId, machine: "Hamed's MacBook",
      tabs: [expect.objectContaining({ tabId: ref.tabId, name: "claude on the desktop", state: "live", agentStatus: "working" })],
    }]);
    await services.kernelTools.keys(ref, ["ctrl+c"]);
    await expect.poll(() => core.terminals.get("t1")?.input.join("")).toContain("\x03");
    expect(runtime.writeInput).not.toHaveBeenCalled();
    expect(await services.kernelTools.desktops?.()).toEqual([{ machine: "Hamed's MacBook", workspaceId: ref.workspaceId, platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } }]);
  });
});

describe("desktop terminal keys, interrupt and wait routes", () => {
  it("presses keys, interrupts and waits for output on the desktop", { timeout: 15_000 }, async () => {
    const { http, path, core } = await linkedMac();
    expect((await http(`${path}/t1/keys`, json({ keys: ["up", "enter"] }))).status).toBe(200);
    await expect.poll(() => core.terminals.get("t1")?.input.join("")).toContain("\r");
    const waiting = http(`${path}/t1/wait`, json({ output: "all done", timeoutMs: 4_000 }));
    // The desktop's program prints it once the wait is under way: what a fresh read of the screen shows.
    await new Promise((resolve) => setTimeout(resolve, 600));
    core.terminals.get("t1")!.screen = "thinking…\r\nall done\r\n";
    core.output("t1", "\r\nall done\r\n");
    const waited = await waiting;
    expect(waited.status).toBe(200);
    expect(await waited.json()).toMatchObject({ reason: "output" });
    // An interrupt watches up to five seconds for what the stop key did.
    const interrupted = await http(`${path}/t1/interrupt`, { ...json({}), signal: AbortSignal.timeout(10_000) });
    expect(interrupted.status).toBe(200);
    const { pressed } = await interrupted.json() as { pressed: string };
    // Esc for an agent that reports status, otherwise Ctrl+C; either reached the desktop.
    expect(core.terminals.get("t1")?.input.join("")).toContain(pressed === "esc" ? "\x1b" : "\x03");
  });

  it("validates bodies at the boundary and refuses an unknown terminal", async () => {
    const { http, path } = await linkedMac();
    expect((await http(`${path}/t1/keys`, json({ keys: [] }))).status).toBe(400);
    expect((await http(`${path}/t1/keys`, json({ keys: ["enter"], extra: 1 }))).status).toBe(400);
    expect((await http(`${path}/t1/wait`, json({ timeoutMs: 10 * 60_000 }))).status).toBe(400);
    expect((await http(`${path}/t99/keys`, json({ keys: ["enter"] }))).status).toBe(404);
    expect((await http(`${path}/t1/interrupt`, { method: "POST", body: "x".repeat(2_048) })).status).toBe(413);
  });
});

describe("The kernel's desktop tools", () => {
  it("lists the linked desktop and starts a terminal there that terminal tools then reach", async () => {
    const { registry, pipeline, core, mac } = await linkedMac();
    const tools = desktopKernelTools(registry, () => "owner_mac");
    expect(await tools.desktops()).toEqual([{ machine: "Hamed's MacBook", workspaceId: desktopLinkWorkspaceId(mac.deviceId), platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } }]);
    const started = await tools.desktopRun({ argv: ["/usr/bin/open", "https://example.com"] });
    expect(core.calls.find((call) => call.method === "terminal.run")?.params).toMatchObject({
      argv: ["/usr/bin/open", "https://example.com"], labels: { "matrix.from": "matrix-demo" },
    });
    const tabs = (await pipeline.listWorkspaces())[0]!.tabs.map((tab) => tab.id);
    expect(tabs).toContain(started.tabId);
    await expect(tools.desktopRun({ machine: "someone else's mac" })).rejects.toMatchObject({ code: "desktop_not_found" });
    await expect(tools.desktopRun({ cwd: "/etc" })).rejects.toMatchObject({ code: "denied" });
  });

  it("shares the start limit with the routes", async () => {
    const { registry, http, path } = await linkedMac();
    const tools = desktopKernelTools(registry, () => "owner_mac");
    for (let index = 0; index < 10; index += 1) await tools.desktopRun({});
    await expect(tools.desktopRun({})).rejects.toMatchObject({ code: "busy" });
    expect((await http(path, json({}))).status).toBe(429);
  });

  it("offers desktop_list and desktop_run only when the Desktop link is on", () => {
    const base = {} as TerminalAgentKernelTools;
    expect(terminalAgentToolDefinitions(base).map((tool) => tool.name)).not.toContain("desktop_run");
    const withMacs = terminalAgentToolDefinitions({ ...base, desktops: vi.fn(async () => []), desktopRun: vi.fn(), desktopScreenshot: vi.fn() });
    expect(withMacs.map((tool) => tool.name)).toEqual(expect.arrayContaining(["desktop_list", "desktop_run"]));
  });
});

describe("Opening a page on each desktop OS", () => {
  it("uses the OS's own opener", () => {
    expect(openPageArgv("darwin", "https://example.com")).toEqual(["/usr/bin/open", "https://example.com"]);
    expect(openPageArgv("linux", "https://example.com")).toEqual(["xdg-open", "https://example.com"]);
    // Fault detected (review): `cmd /c start` cut a URL at its first `&`.
    expect(openPageArgv("win32", "https://example.com/?a=1&b=2")).toEqual(["rundll32.exe", "url.dll,FileProtocolHandler", "https://example.com/?a=1&b=2"]);
  });
});

describe("matrix shell machine keys, wait and open", () => {
  it("opens a page in the desktop's browser and refuses anything but http and https", async () => {
    const { base, core } = await linkedMac();
    const output: string[] = [];
    const errors: string[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((line: unknown) => { output.push(String(line)); });
    const error = vi.spyOn(console, "error").mockImplementation((line: unknown) => { errors.push(String(line)); });
    cleanup.push(() => { log.mockRestore(); error.mockRestore(); process.exitCode = 0; });
    const flags = ["--gateway", `http://${base}`, "--token", LOCAL_TOKEN];
    await runCommand(shellMachineCommand, { rawArgs: ["open", "Hamed's MacBook", "https://example.com/page", ...flags] });
    expect(core.calls.find((call) => call.method === "terminal.run")?.params).toMatchObject({ argv: ["/usr/bin/open", "https://example.com/page"] });
    await runCommand(shellMachineCommand, { rawArgs: ["open", "Hamed's MacBook", "file:///etc/passwd", ...flags] });
    expect(errors.at(-1)).toContain("http or https");
    await runCommand(shellMachineCommand, { rawArgs: ["keys", "Hamed's MacBook", "t1", "ctrl+c", ...flags] });
    expect(errors).toEqual(["Give a full http or https address"]);
    expect(output.at(-1)).toContain("Pressed ctrl+c in t1");
  });
});
