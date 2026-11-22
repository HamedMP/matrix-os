import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HERDR_TERMINAL_WORKSPACE_ID } from "@matrix-os/contracts/herdr-terminals";
import { createHerdrAdapter, type HerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { createTerminalWorkspaceProjectAdmission } from "../../packages/gateway/src/shell/workspace-routes.js";
import { createTerminalAgentServices, type TerminalAgentServices } from "../../packages/gateway/src/terminal-agent/services.js";
import type { TerminalEventFrame } from "../../packages/gateway/src/terminal-agent/events.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const ref = (id: string) => ({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId(id) });

async function setup() {
  const home = await mkdtemp(join(tmpdir(), "matrix-herdr-agent-"));
  roots.push(home);
  const core = createFakeHerdrCore();
  const adapter: HerdrAdapter = createHerdrAdapter({ open: async () => core.connect(), ttlMs: 0, captureQuietMs: 5, captureMaxMs: 100 });
  closers.push(() => adapter.close());
  const runtime = {
    listWorkspaces: async () => [],
    getSnapshot: async () => undefined,
    writeInput: vi.fn(async () => undefined),
    listAgentStatuses: async () => [],
  };
  const services: TerminalAgentServices = createTerminalAgentServices({
    runtime: runtime as never,
    homePath: home,
    terminalOwnerIds: ["owner"],
    projectAdmission: createTerminalWorkspaceProjectAdmission({ runtime }),
    herdr: adapter,
  });
  closers.push(() => services.close());
  return { core, adapter, services, runtime };
}

describe("Herdr terminals in the terminal-agent pipeline", () => {
  it("lists Herdr terminals beside Matrix tabs with Herdr's own status", async () => {
    const { core, services } = await setup();
    core.add("t1", { title: "claude", status: { state: "blocked", msg: "Allow?" } });
    const listed = await services.kernelTools.list();
    expect(listed).toEqual([{ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabs: [
      { tabId: herdrTabId("t1"), name: "claude", cwd: "", state: "live", agentStatus: "blocked" },
    ] }]);
    expect(await services.verbs.get(ref("t1"))).toMatchObject({ state: "live", agentStatus: "blocked" });
  });

  it("resolves a wait as exited when the Herdr terminal ends during it", async () => {
    const { core, services } = await setup();
    core.add("t1", { status: { state: "working" } });
    const waiting = services.waiter.wait(ref("t1"), { timeoutMs: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    core.terminals.delete("t1");
    await expect(waiting).resolves.toEqual({ reason: "exited", exitCode: null });
  });

  it("reports an ended Herdr terminal as finished", async () => {
    const { core, services, adapter } = await setup();
    core.add("t1");
    expect(await services.verbs.get(ref("t1"))).toMatchObject({ state: "live" });
    core.terminals.delete("t1");
    expect(await services.verbs.get(ref("t1"))).toMatchObject({ state: "finished" });
    expect((await adapter.list()).sessions).toEqual([]);
  });

  it("reads a Herdr terminal's screen", async () => {
    const { core, services } = await setup();
    core.add("t1", { screen: "$ make\r\nok" });
    expect(await services.verbs.read(ref("t1"), { lines: 0 })).toEqual({ screen: "$ make\nok", history: "", lines: 0 });
  });

  it("sends text and keys into a Herdr terminal, never into the Matrix runtime", async () => {
    const { core, services, runtime } = await setup();
    core.add("t1");
    await services.verbs.send(ref("t1"), { text: "run tests" });
    await services.verbs.keys(ref("t1"), { keys: ["ctrl+c", "enter"] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(core.terminals.get("t1")!.input).toEqual(["run tests\r", "\x03\r"]);
    expect(runtime.writeInput).not.toHaveBeenCalled();
  });

  it("refuses to send into a Herdr terminal that is asking for permission", async () => {
    const { core, services } = await setup();
    core.add("t1", { status: { state: "blocked" } });
    await expect(services.verbs.send(ref("t1"), { text: "hello" })).rejects.toMatchObject({ code: "blocked" });
    expect(core.terminals.get("t1")!.input).toEqual([]);
  });

  it("interrupts a Herdr shell with Ctrl+C", async () => {
    const { core, services } = await setup();
    core.add("t1", { status: { state: "done" } });
    const controller = new AbortController();
    const pending = services.verbs.interrupt(ref("t1"), { signal: controller.signal });
    await vi.waitFor(() => expect(core.terminals.get("t1")!.input).toEqual(["\x03"]));
    controller.abort();
    expect((await pending).pressed).toBe("ctrl+c");
  });

  it("ends a wait when the Herdr agent stops working", async () => {
    const { core, services } = await setup();
    core.add("t1", { status: { state: "working" } });
    const waited = services.waiter.wait(ref("t1"), { timeoutMs: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    core.terminals.get("t1")!.status = { state: "done" };
    expect(await waited).toEqual({ reason: "stopped", status: "done" });
  });

  it("reports a blocked Herdr agent on the events stream, so attention sees it", async () => {
    const { core, services } = await setup();
    core.add("t1", { title: "claude", status: { state: "blocked", msg: "Allow edit?" } });
    const frames: TerminalEventFrame[] = [];
    const handle = services.events.subscribe({ send: (frame) => frames.push(frame), close: () => undefined });
    await services.events.tick();
    handle.close();
    const snapshot = frames.find((frame) => frame.type === "snapshot");
    expect(snapshot && snapshot.type === "snapshot" ? snapshot.tabs : []).toContainEqual(expect.objectContaining({
      ref: ref("t1"), name: "claude", state: "live", agentStatus: "blocked", statusMessage: "Allow edit?",
    }));
  });

  it("does not ask project admission about the Herdr workspace", async () => {
    const projectOperationAdmission = { withLegacyAdmission: vi.fn(async () => { throw new Error("not a project"); }) };
    const admission = createTerminalWorkspaceProjectAdmission({
      runtime: { listWorkspaces: async () => [] },
      projectOperationAdmission: projectOperationAdmission as never,
    });
    expect(await admission.withWorkspace("owner", HERDR_TERMINAL_WORKSPACE_ID, "run", async () => "ran")).toBe("ran");
    expect(projectOperationAdmission.withLegacyAdmission).not.toHaveBeenCalled();
    await expect(admission.withWorkspace("owner", `tws_${"1".repeat(32)}`, "run", async () => "ran")).rejects.toMatchObject({ code: "not_found" });
  });
});
