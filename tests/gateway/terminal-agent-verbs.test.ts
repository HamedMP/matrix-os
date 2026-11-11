import { describe, expect, it, vi } from "vitest";
import { createTerminalAgentVerbs, TerminalAgentVerbError } from "../../packages/gateway/src/terminal-agent/verbs.js";
import { createTerminalInputActivity } from "../../packages/gateway/src/terminal-agent/input-activity.js";

const workspaceId = "tws_0123456789abcdef0123456789abcdef";
const tabId = "tt_0123456789abcdef0123456789abcdef";
const ref = { workspaceId, tabId };
const incarnation = `ti_${"a".repeat(32)}`;

function tab(overrides: Record<string, unknown> = {}) {
  return {
    id: tabId, workspaceId, name: "review", cwd: "projects/app", status: "running",
    revision: 1, order: 0, accessScope: "owner", createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z", incarnation, ...overrides,
  };
}

function harness(options: {
  tab?: Record<string, unknown>;
  snapshot?: unknown;
  status?: "idle" | "working" | "done" | "blocked" | "error";
} = {}) {
  let now = 1_000_000;
  const writes: Array<{ data: string; expectedIncarnation?: string }> = [];
  const runtime = {
    listWorkspaces: vi.fn(async () => [{
      id: workspaceId, scope: "main", canonicalSize: { cols: 120, rows: 36 }, status: "running",
      revision: 1, createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z",
      tabs: [tab(options.tab)],
    }]),
    getSnapshot: vi.fn(async () => options.snapshot),
    writeInput: vi.fn(async (_ref: unknown, data: string, expectedIncarnation?: string) => {
      writes.push({ data, ...(expectedIncarnation ? { expectedIncarnation } : {}) });
    }),
  };
  const inputActivity = createTerminalInputActivity({ now: () => now });
  const sleeps: number[] = [];
  const verbs = createTerminalAgentVerbs({
    runtime,
    inputActivity,
    ...(options.status ? { agentStatus: () => options.status } : {}),
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  });
  return { verbs, runtime, writes, inputActivity, sleeps, time: () => now };
}

function harnessWithStatus(status: () => "working" | "blocked") {
  let now = 1_000_000;
  const writes: Array<{ data: string }> = [];
  const runtime = {
    listWorkspaces: async () => [{
      id: workspaceId, scope: "main", canonicalSize: { cols: 120, rows: 36 }, status: "running",
      revision: 1, createdAt: "2026-11-11T10:00:00.000Z", updatedAt: "2026-11-11T10:00:00.000Z", tabs: [tab()],
    }],
    getSnapshot: async () => undefined,
    writeInput: async (_ref: unknown, data: string) => { writes.push({ data }); },
  };
  const inputActivity = createTerminalInputActivity({ now: () => now });
  const verbs = createTerminalAgentVerbs({
    runtime: runtime as never, inputActivity, agentStatus: () => status(),
    now: () => now, sleep: async (ms) => { now += ms; },
  });
  return { verbs, writes, inputActivity };
}

const snapshot = {
  schemaVersion: 1,
  terminalRef: ref,
  revision: 3,
  presentationRevision: 0,
  seq: 42,
  ansi: "",
  viewport: ["$ bun test", "4 passed", "$ "],
  scrollback: ["line 1", "line 2", "line 3"],
  updatedAt: "2026-11-11T10:05:00.000Z",
};

describe("terminal agent verbs: read", () => {
  // Fault detected: an agent cannot collect a helper's result without attaching to it.
  it("returns the screen plus the requested history lines as text", async () => {
    const { verbs } = harness({ snapshot });
    await expect(verbs.read(ref, { lines: 2 })).resolves.toEqual({
      screen: "$ bun test\n4 passed\n$ ",
      history: "line 2\nline 3",
      lines: 2,
      updatedAt: "2026-11-11T10:05:00.000Z",
    });
    await expect(verbs.read(ref, { lines: 0 })).resolves.toMatchObject({ history: "", lines: 0 });
  });

  it("marks the read incomplete instead of inventing a screen when no snapshot exists", async () => {
    const { verbs } = harness({ snapshot: undefined });
    await expect(verbs.read(ref, { lines: 100 })).resolves.toEqual({
      screen: "", history: "", lines: 0, incomplete: true, why: "unavailable",
    });
  });

  it("does not return another tab's snapshot", async () => {
    const { verbs } = harness({ snapshot: { ...snapshot, terminalRef: { workspaceId, tabId: `tt_${"b".repeat(32)}` } } });
    await expect(verbs.read(ref, { lines: 10 })).resolves.toMatchObject({ incomplete: true });
  });

  it("refuses unknown tabs and tabs that are not owner terminals", async () => {
    const { verbs } = harness({ snapshot });
    await expect(verbs.read({ workspaceId, tabId: `tt_${"c".repeat(32)}` }, { lines: 1 }))
      .rejects.toMatchObject({ code: "not_found" });
    const chat = harness({ snapshot, tab: { accessScope: "chat" } });
    await expect(chat.verbs.read(ref, { lines: 1 })).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("terminal agent verbs: send", () => {
  // Fault detected: a delegated task never submits, or lands in a different incarnation of the tab.
  it("types single-line text and presses Enter for this exact incarnation", async () => {
    const { verbs, writes } = harness();
    await expect(verbs.send(ref, { text: "focus on the first bug" })).resolves.toEqual({ sent: true, heldMs: 0 });
    // One write: two concurrent sends must not interleave text and Enter.
    expect(writes).toEqual([{ data: "focus on the first bug\r", expectedIncarnation: incarnation }]);
  });

  it("pastes multi-line text as one bracketed paste so it is not submitted line by line", async () => {
    const { verbs, writes } = harness();
    await verbs.send(ref, { text: "line one\nline two" });
    expect(writes.map((write) => write.data)).toEqual(["\x1b[200~line one\nline two\x1b[201~\r"]);
  });

  it("strips paste markers out of the text so a sender cannot end the paste early", async () => {
    const { verbs, writes } = harness();
    await verbs.send(ref, { text: "a\nb\x1b[201~\rrm -rf ~\r" });
    expect(writes[0]?.data).toBe("\x1b[200~a\nb\nrm -rf ~\n\x1b[201~\r");
  });

  // Fault detected: an automated send answers a permission prompt meant for the person.
  it("refuses a blocked agent unless forced", async () => {
    const blocked = harness({ status: "blocked" });
    await expect(blocked.verbs.send(ref, { text: "yes" })).rejects.toMatchObject({ code: "blocked" });
    expect(blocked.writes).toEqual([]);
    await expect(blocked.verbs.send(ref, { text: "yes", force: true })).resolves.toMatchObject({ sent: true });
  });

  // Fault detected: a send held for a person's draft answers a permission prompt
  // that appeared while it waited.
  it("checks for a blocked agent again after waiting for a draft", async () => {
    // Working when the send starts; the agent asks for permission during the hold.
    let checks = 0;
    const { verbs, writes, inputActivity } = harnessWithStatus(() => (checks++ === 0 ? "working" : "blocked"));
    inputActivity.record(ref);
    await expect(verbs.send(ref, { text: "yes" })).rejects.toMatchObject({ code: "blocked" });
    expect(writes).toEqual([]);
  });

  // Fault detected: an agent's message is spliced into what the person is typing.
  it("holds while a person is typing and sends after a quiet pause", async () => {
    const { verbs, writes, inputActivity, sleeps } = harness();
    inputActivity.record(ref);
    const result = await verbs.send(ref, { text: "hello" });
    expect(result.heldMs).toBe(3_000);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(3_000);
    expect(writes.map((write) => write.data)).toEqual(["hello\r"]);
  });

  it("never holds longer than the draft limit even if the person keeps typing", async () => {
    const { verbs, inputActivity, writes, time } = harness();
    // The person presses a key at every check: the hold must still end.
    vi.spyOn(inputActivity, "lastInputAt").mockImplementation(() => time());
    const result = await verbs.send(ref, { text: "hi" });
    expect(result.heldMs).toBe(60_000);
    expect(writes.map((write) => write.data)).toEqual(["hi\r"]);
  });

  it("refuses to type into a finished terminal", async () => {
    const { verbs } = harness({ tab: { status: "exited", exitCode: 0 } });
    await expect(verbs.send(ref, { text: "x" })).rejects.toMatchObject({ code: "finished" });
  });
});

describe("terminal agent verbs: keys and interrupt", () => {
  it("presses named keys as one write", async () => {
    const { verbs, writes } = harness();
    await expect(verbs.keys(ref, { keys: ["down", "enter"] })).resolves.toEqual({ pressed: 2 });
    expect(writes).toEqual([{ data: "\x1b[B\r", expectedIncarnation: incarnation }]);
  });

  // Fault detected: interrupting an agent kills its process instead of stopping its turn.
  it("presses Esc for an agent that reports status and Ctrl+C for a plain program", async () => {
    const agent = harness({ status: "working" });
    await expect(agent.verbs.interrupt(ref)).resolves.toEqual({ pressed: "esc" });
    expect(agent.writes[0]?.data).toBe("\x1b");
    const plain = harness();
    await expect(plain.verbs.interrupt(ref)).resolves.toEqual({ pressed: "ctrl+c" });
    expect(plain.writes[0]?.data).toBe("\x03");
  });
});

describe("terminal agent verbs: get", () => {
  it("reports the tab with its agent status and exit code", async () => {
    const { verbs } = harness({ status: "done", tab: { status: "exited", exitCode: 3 } });
    await expect(verbs.get(ref)).resolves.toMatchObject({
      tab: { id: tabId, status: "exited", exitCode: 3 },
      agentStatus: "done",
      state: "finished",
    });
  });

  it("is a typed error, not a raw Response", () => {
    expect(new TerminalAgentVerbError("blocked")).toBeInstanceOf(Error);
  });
});
