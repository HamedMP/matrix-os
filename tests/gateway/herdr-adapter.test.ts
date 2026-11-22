import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalWorkspaceSchema } from "@matrix-os/contracts";
import { HERDR_TERMINAL_WORKSPACE_ID, HerdrSessionListSchema } from "@matrix-os/contracts/herdr-terminals";
import { HerdrTransportError } from "@matrix-os/herdr-core-client/session-host";
import { createHerdrAdapter, type HerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { herdrTabId } from "../../packages/gateway/src/herdr/refs.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const adapters: HerdrAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map((adapter) => adapter.close())); });

function setup(options: { version?: string; open?: () => Promise<never> } = {}) {
  const core = createFakeHerdrCore({ version: options.version });
  let clock = 1_000_000;
  const adapter = createHerdrAdapter({
    open: options.open ?? (async () => core.connect()),
    now: () => clock,
    random: () => 1,
    captureQuietMs: 5,
    captureMaxMs: 200,
  });
  adapters.push(adapter);
  return { core, adapter, advance: (ms: number) => { clock += ms; } };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("herdr adapter discovery", () => {
  it("lists the core's live terminals with Matrix tab ids and Herdr's own status", async () => {
    const { core, adapter } = setup();
    core.add("t1", { title: "claude", status: { state: "blocked", msg: "Allow edit?" } });
    core.add("t2", { title: "build" });

    const listed = await adapter.list();

    expect(HerdrSessionListSchema.parse(listed)).toEqual({
      available: true,
      status: "ready",
      sessions: [
        { id: "t1", tabId: herdrTabId("t1"), title: "claude", status: "blocked", statusMessage: "Allow edit?" },
        { id: "t2", tabId: herdrTabId("t2"), title: "build", status: null },
      ],
    });
  });

  it("caches a listing for two seconds, then asks the core again", async () => {
    const { core, adapter, advance } = setup();
    core.add("t1");
    await adapter.list();
    await adapter.list();
    expect(core.calls.filter((call) => call.method === "terminal.list")).toHaveLength(1);
    advance(2_001);
    core.add("t2");
    expect((await adapter.list()).sessions.map((session) => session.id)).toEqual(["t1", "t2"]);
    expect(core.calls.filter((call) => call.method === "terminal.list")).toHaveLength(2);
  });

  it("reports not-installed when herdr-core is missing, with no sessions", async () => {
    const { adapter } = setup({ open: async () => { throw new HerdrTransportError("not-installed"); } });
    expect(await adapter.list()).toEqual({ available: false, status: "not-installed", sessions: [] });
  });

  it("reports unsupported for a core older than 0.1.14", async () => {
    const { core, adapter } = setup({ version: "0.1.13" });
    core.add("t1");
    expect(await adapter.list()).toEqual({ available: false, status: "unsupported", sessions: [] });
  });

  it("never sends a method outside the restricted list", async () => {
    const { core, adapter } = setup();
    core.add("t1");
    await adapter.list();
    await adapter.kill("t1");
    expect(new Set(core.calls.map((call) => call.method))).toEqual(new Set(["terminal.list", "terminal.kill"]));
  });

  it("bounds a listing to 500 sessions", async () => {
    const { core, adapter } = setup();
    for (let index = 0; index < 520; index += 1) core.add(`t${index}`);
    expect((await adapter.list()).sessions).toHaveLength(500);
  });

  it("projects the listing as a canonical terminal workspace whose refs resolve back to herdr ids", async () => {
    const { core, adapter } = setup();
    core.add("t7", { title: "agent" });
    await adapter.list();

    const workspace = TerminalWorkspaceSchema.parse(await adapter.workspace());
    expect(workspace.id).toBe(HERDR_TERMINAL_WORKSPACE_ID);
    expect(workspace.tabs.map((tab) => [tab.id, tab.name, tab.accessScope])).toEqual([[herdrTabId("t7"), "agent", "owner"]]);
    expect(adapter.resolve({ workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId("t7") })).toBe("t7");
    expect(adapter.resolve({ workspaceId: `tws_${"1".repeat(32)}`, tabId: herdrTabId("t7") })).toBeUndefined();
  });

  it("reports statuses with a report time that moves only when the status changes", async () => {
    const { core, adapter, advance } = setup();
    core.add("t1", { status: { state: "working" } });
    const first = await adapter.statuses();
    advance(5_000);
    const same = await adapter.statuses();
    core.terminals.get("t1")!.status = { state: "done", msg: "Finished" };
    advance(5_000);
    const changed = await adapter.statuses();

    expect(first).toEqual([{ ref: { workspaceId: HERDR_TERMINAL_WORKSPACE_ID, tabId: herdrTabId("t1") }, status: "working",
      reportedAt: new Date(1_000_000).toISOString(), source: "reporter" }]);
    expect(same[0]!.reportedAt).toBe(first[0]!.reportedAt);
    expect(changed[0]).toMatchObject({ status: "done", message: "Finished", reportedAt: new Date(1_010_000).toISOString() });
  });

  it("reports unavailable while the core is down and reconnects once it is back", async () => {
    let down = false;
    const core = createFakeHerdrCore();
    const { adapter, advance } = setup({ open: async () => {
      if (down) throw new Error("connect failed");
      return core.connect() as never;
    } });
    core.add("t1");
    expect((await adapter.list()).status).toBe("ready");
    down = true;
    core.crash();
    await tick();
    advance(2_001);
    expect(await adapter.list()).toEqual({ available: false, status: "unavailable", sessions: [] });
    down = false;
    advance(31_000);
    expect((await adapter.list()).status).toBe("ready");
  });

  it("logs a listing failure's safe kind once while it keeps failing, and again after a recovery", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { core, adapter, advance } = setup();
      core.add("t1");
      core.failList("busy /home/secret");
      const failures = () => warn.mock.calls.filter((call) => call[0] === "[herdr] terminal listing failed");
      expect((await adapter.list()).available).toBe(false);
      advance(2_001);
      await adapter.list();
      expect(failures()).toEqual([["[herdr] terminal listing failed", "call_error"]]);
      core.failList(null);
      advance(2_001);
      expect((await adapter.list()).available).toBe(true);
      core.failList("busy");
      advance(2_001);
      await adapter.list();
      expect(failures()).toHaveLength(2);
      expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    } finally {
      warn.mockRestore();
    }
  });

  it("retries a missing core on refresh", async () => {
    let installed = false;
    const core = createFakeHerdrCore();
    core.add("t1");
    let clock = 0;
    const adapter = createHerdrAdapter({
      open: async () => { if (!installed) throw new HerdrTransportError("not-installed"); return core.connect(); },
      now: () => clock,
      random: () => 1,
    });
    adapters.push(adapter);
    expect((await adapter.list()).status).toBe("not-installed");
    installed = true;
    clock += 60_000;
    await adapter.refresh();
    expect((await adapter.list()).status).toBe("ready");
  });
});

describe("herdr adapter attachments", () => {
  it("delivers the first paint and returns credit only once output is consumed", async () => {
    const { core, adapter } = setup();
    core.add("t1", { screen: "hello" });
    await adapter.list();
    const output: Array<{ data: string; consumed: () => void }> = [];
    const attachment = await adapter.attach("t1", { cols: 80, rows: 24 }, {
      output: (data, consumed) => output.push({ data, consumed }),
      closed: () => undefined,
    });

    expect(output.map((entry) => entry.data)).toEqual(["hello"]);
    expect(core.viewers[0]!.credits).toBe(0);
    output[0]!.consumed();
    await tick();
    expect(core.viewers[0]!.credits).toBe(5);

    attachment.input("ls\r");
    attachment.resize(100, 30);
    await tick();
    expect(core.terminals.get("t1")!.input).toEqual(["ls\r"]);
    expect(core.terminals.get("t1")!.resizes).toEqual([{ cols: 100, rows: 30 }]);

    attachment.detach();
    await tick();
    expect(core.viewers).toHaveLength(0);
  });

  it("tells the viewer when the terminal ends", async () => {
    const { core, adapter } = setup();
    core.add("t1");
    await adapter.list();
    let closed = 0;
    await adapter.attach("t1", { cols: 80, rows: 24 }, { output: (_data, consumed) => consumed(), closed: () => { closed += 1; } });
    await adapter.kill("t1");
    await tick();
    expect(closed).toBe(1);
    expect((await adapter.list()).sessions).toEqual([]);
  });

  it("tells every viewer when the core goes away", async () => {
    const { core, adapter } = setup();
    core.add("t1");
    await adapter.list();
    let closed = 0;
    await adapter.attach("t1", { cols: 80, rows: 24 }, { output: (_data, consumed) => consumed(), closed: () => { closed += 1; } });
    core.crash();
    await tick();
    expect(closed).toBe(1);
  });

  it("reads a terminal's screen by rendering the core's paint", async () => {
    const { core, adapter } = setup();
    core.add("t1", { screen: "\x1b[2J\x1b[Hline one\r\nline two\x1b[1;6H1" });
    await adapter.list();
    const screen = await adapter.captureScreen("t1", 10);
    expect(screen.viewport.slice(0, 2)).toEqual(["line 1ne", "line two"]);
    expect(core.viewers).toHaveLength(0);
  });

  it("types into a terminal through a short attachment", async () => {
    const { core, adapter } = setup();
    core.add("t1", { screen: "prompt$ " });
    await adapter.list();
    await adapter.writeInput("t1", "echo hi\r");
    await tick();
    expect(core.terminals.get("t1")!.input).toEqual(["echo hi\r"]);
    expect(core.viewers).toHaveLength(0);
    expect(core.sockets[0]!.destroyed).toBe(false);
  });

  it("tells a viewer whether its terminal exited or the core connection dropped", async () => {
    const { core, adapter } = setup();
    core.add("t1");
    core.add("t2");
    await adapter.list();
    const reasons: string[] = [];
    await adapter.attach("t1", { cols: 80, rows: 24 }, { output: (_data, consumed) => consumed(), closed: (reason) => { reasons.push(`t1:${reason}`); } });
    await adapter.attach("t2", { cols: 80, rows: 24 }, { output: (_data, consumed) => consumed(), closed: (reason) => { reasons.push(`t2:${reason}`); } });
    await adapter.kill("t1");
    await tick();
    expect(reasons).toEqual(["t1:exited"]);
    core.crash();
    await tick();
    expect(reasons).toEqual(["t1:exited", "t2:disconnected"]);
  });

  it("reads as a watch-only viewer, so a read never resizes the owner's program", async () => {
    const { core, adapter } = setup();
    core.add("t1", { screen: "x" });
    await adapter.list();
    await adapter.captureScreen("t1", 10);
    await adapter.writeInput("t1", "ls\r");
    const attaches = core.calls.filter((call) => call.method === "terminal.attach");
    expect(attaches[0]!.params).toMatchObject({ observe: true });
    // Typing needs a typing viewer.
    expect(attaches[1]!.params).not.toHaveProperty("observe");
  });

  it("asks the core for as much history as a read wants", async () => {
    const { core, adapter } = setup();
    core.add("t1", { screen: "x" });
    await adapter.list();
    await adapter.captureScreen("t1", 8_000);
    const attaches = core.calls.filter((call) => call.method === "terminal.attach");
    expect(attaches.at(-1)!.params).toMatchObject({ history: 8_000 });
  });

  it("does not answer a deeper read from a shallower cached read", async () => {
    const { core, adapter } = setup();
    const history = Array.from({ length: 60 }, (_, index) => `h${index}`).join("\r\n");
    core.add("t1", { screen: `${history}\r\n${"\r\n".repeat(120)}end` });
    await adapter.list();
    const shallow = await adapter.captureScreen("t1", 5);
    const deep = await adapter.captureScreen("t1", 50);
    const again = await adapter.captureScreen("t1", 5);
    expect(shallow.scrollback).toHaveLength(5);
    expect(deep.scrollback.length).toBeGreaterThan(5);
    expect(deep.scrollback.length).toBeLessThanOrEqual(50);
    expect(again.scrollback).toEqual(deep.scrollback.slice(-5));
    expect(core.calls.filter((call) => call.method === "terminal.attach")).toHaveLength(2);
  });

  it("renders a read at least as wide as the last writer, so wide lines do not wrap", async () => {
    const { core, adapter } = setup();
    const wide = "w".repeat(420);
    core.add("t1", { screen: wide });
    await adapter.list();
    adapter.rememberSize("t1", { cols: 450, rows: 40 });
    const screen = await adapter.captureScreen("t1", 0);
    expect(screen.viewport[0]).toBe(wide);
  });

  it("closes attachments and the connection on close", async () => {
    const { core, adapter } = setup();
    core.add("t1");
    await adapter.list();
    let closed = 0;
    await adapter.attach("t1", { cols: 80, rows: 24 }, { output: (_data, consumed) => consumed(), closed: () => { closed += 1; } });
    await adapter.close();
    expect(closed).toBe(1);
    expect(core.sockets.every((socket) => socket.destroyed)).toBe(true);
    expect((await adapter.list()).available).toBe(false);
  });
});
