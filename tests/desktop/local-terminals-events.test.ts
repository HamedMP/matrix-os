import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalTerminalEvents } from "@desktop/main/local-terminals/hc-events";
import type { LocalTerminalFact } from "@matrix-os/ui/terminal-status-sidebar";

// Spec 2706 layer 4: the Terminal window learns local terminal status from
// herdr-core's `events.subscribe` instead of listing every 3 seconds.

class PlainCore extends EventEmitter {
  lines: Array<Record<string, unknown>> = [];
  destroyed = false;
  write(data: Buffer | string) {
    for (const line of String(data).split("\n").filter(Boolean)) this.lines.push(JSON.parse(line) as Record<string, unknown>);
    return true;
  }
  destroy() { this.destroyed = true; }
  send(value: unknown) { this.emit("data", Buffer.from(`${JSON.stringify(value)}\n`)); }
  hello(version = "0.1.19") { this.send({ id: 1, jsonrpc: "2.0", result: { version, generation: 1, framed: false, features: ["events"] } }); }
  snapshot(terminals: unknown[], seq = 10) { this.send({ id: 2, jsonrpc: "2.0", result: { channel: null, seq, terminals } }); }
  event(type: string, terminal: string, data: unknown, seq = 11) { this.send({ jsonrpc: "2.0", method: "event", params: { type, terminal, data, seq } }); }
}

const terminal = (address: string, overrides: Record<string, unknown> = {}) => ({
  address, argv: ["zsh", "-l"], cols: 80, rows: 24, created_ms: 1_000, cwd: "/Users/me", labels: {},
  name: null, parent: null, state: "live", status: null, status_ms: null, title: "zsh", turn: 0, exit_code: null, finished_ms: null,
  ...overrides,
});

function harness() {
  const cores: PlainCore[] = [];
  const changes: LocalTerminalFact[][] = [];
  const events = createLocalTerminalEvents({
    open: () => { const core = new PlainCore(); cores.push(core); return core; },
    expectedVersion: "0.1.19",
    onChange: (facts) => changes.push(facts),
    now: () => 50_000,
  });
  return { events, cores, changes, latest: () => changes.at(-1) ?? [] };
}

describe("local terminal events", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("subscribes after a plain handshake and turns the snapshot into facts", async () => {
    const h = harness();
    h.events.start();
    const core = h.cores[0]!;
    expect(core.lines[0]).toMatchObject({ id: 1, method: "hello", params: {} });
    core.hello();
    expect(core.lines[1]).toMatchObject({ id: 2, method: "events.subscribe", params: {} });
    core.snapshot([
      terminal("t1", { status: { state: "done", app: "claude-code" }, status_ms: 2_000, turn: 3, labels: { "herdr.seen": "3", "matrix.title": "Review" } }),
      terminal("t2", { parent: "t1", status: { state: "working" }, status_ms: 3_000, title: "helper" }),
      terminal("t3", { state: "finished", exit_code: 4, finished_ms: 4_000, labels: { "matrix.agent": "codex" } }),
    ]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()).toEqual([
      { id: "t1", title: "Review", status: "done", statusAt: 2_000, turn: 3, seenTurn: 3, finished: false, agent: "claude" },
      { id: "t2", title: "helper", status: "working", statusAt: 3_000, turn: 0, seenTurn: null, finished: false, parent: "t1" },
      { id: "t3", title: "zsh", status: null, statusAt: 4_000, turn: 0, seenTurn: null, finished: true, finishedSeen: false, agent: "codex" },
    ]);
  });

  // Fault detected (Greptile, #3566): an app named like an Object property ("constructor") gave a
  // function as the agent, which failed validation and stopped every local status update.
  it("ignores an app name that is not one of the known agents", async () => {
    const h = harness();
    h.events.start();
    const core = h.cores[0]!;
    core.hello();
    core.snapshot([terminal("t1", { status: { state: "working", app: "constructor" }, status_ms: 1_000 })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()?.[0]?.agent).toBeUndefined();
    expect(h.latest()?.[0]?.status).toBe("working");
  });

  it("applies events in order: status, turn, labels, finished, removed, created", async () => {
    const h = harness();
    h.events.start();
    const core = h.cores[0]!;
    core.hello();
    core.snapshot([terminal("t1")]);
    core.event("status", "t1", { status: { state: "blocked", msg: "approve\u0007 v2?\u202e" }, reported: true });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()[0]).toMatchObject({ status: "blocked", statusMessage: "approve v2?" });
    core.event("status", "t1", { status: { state: "working" }, reported: true });
    core.event("status", "t1", { status: { state: "done" }, reported: true });
    core.event("turn", "t1", { turn: 1 });
    core.event("labels", "t1", { labels: { "herdr.seen": "1" } });
    core.event("created", "t9", terminal("t9", { title: "new" }));
    core.event("finished", "t9", { exit_code: 0, finished_ms: 60_000, reason: "exited" });
    core.event("title", "t9", { title: "renamed" });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()).toEqual([
      expect.objectContaining({ id: "t1", status: "done", statusAt: 50_000, turn: 1, seenTurn: 1 }),
      expect.objectContaining({ id: "t9", title: "renamed", finished: true, statusAt: 60_000, status: null }),
    ]);
    core.event("removed", "t9", {});
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest().map((fact) => fact.id)).toEqual(["t1"]);
  });

  it("keeps facts of terminals on added machines under their machine address", async () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello();
    h.cores[0]!.snapshot([terminal("vps/t4", { parent: "t2" })]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()).toEqual([expect.objectContaining({ id: "vps/t4", parent: "vps/t2" })]);
  });

  it("drops terminals it cannot read and strips control characters from titles", async () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello();
    h.cores[0]!.snapshot([terminal("../etc"), terminal("t5", { title: "a\u001b[31mb‮" }), { address: "t6" }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(h.latest()).toEqual([expect.objectContaining({ id: "t5", title: "a[31mb" })]);
  });

  it("refuses a core of another version without subscribing", () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello("0.2.0");
    expect(h.cores[0]!.lines.map((line) => line.method)).toEqual(["hello"]);
    expect(h.cores[0]!.destroyed).toBe(true);
  });

  it("reconnects with backoff after a drop, and resubscribes after missing events", async () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello();
    h.cores[0]!.snapshot([terminal("t1")]);
    h.cores[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(999);
    expect(h.cores).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.cores).toHaveLength(2);
    h.cores[1]!.hello();
    h.cores[1]!.snapshot([terminal("t1")]);
    h.cores[1]!.send({ jsonrpc: "2.0", method: "missed", params: { seq: 40 } });
    expect(h.cores[1]!.destroyed).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.cores).toHaveLength(3);
  });

  it("reconnects when the core goes silent past its heartbeat", async () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello();
    h.cores[0]!.snapshot([]);
    await vi.advanceTimersByTimeAsync(44_000);
    h.cores[0]!.send({ jsonrpc: "2.0", method: "heartbeat", params: { seq: 10 } });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(h.cores[0]!.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.cores[0]!.destroyed).toBe(true);
  });

  it("refuses a line longer than its cap", () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.emit("data", Buffer.alloc(17 * 1024 * 1024, 0x61));
    expect(h.cores[0]!.destroyed).toBe(true);
  });

  it("stops for good: no reconnect, no more changes", async () => {
    const h = harness();
    h.events.start();
    h.cores[0]!.hello();
    h.events.stop();
    expect(h.cores[0]!.destroyed).toBe(true);
    h.cores[0]!.emit("close");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.cores).toHaveLength(1);
    expect(h.events.facts()).toEqual([]);
  });
});
