import { describe, expect, it } from "vitest";
import { RuntimeSummarySchema } from "../../packages/contracts/src/index";
import { deriveAgentInbox, formatInboxTime } from "../../packages/ui/src/agent-inbox-model";
import type { TerminalTabFacts } from "../../packages/ui/src/terminal-agents/attention";

const WS = "tws_00000000000000000000000000000001";
const TAB_A = "tt_00000000000000000000000000000001";
const TAB_B = "tt_00000000000000000000000000000002";
const at = (minutes: number) => new Date(Date.parse("2026-11-16T12:00:00.000Z") - minutes * 60_000).toISOString();

function thread(id: string, overrides: Record<string, unknown> = {}) {
  return { id, providerId: "codex", title: "Coding agent run", status: "running", attention: "none", createdAt: at(30), updatedAt: at(5), ...overrides };
}

function summary(overrides: Record<string, unknown> = {}) {
  return RuntimeSummarySchema.parse({
    runtime: { id: "rt_primary", label: "Main", status: "available" }, capabilities: [],
    providers: [
      { id: "codex", displayName: "Codex", kind: "codex", availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [] },
      { id: "claude", displayName: "Claude Code", kind: "claude", availability: "available", installStatus: "installed", authStatus: "authenticated", supportedModes: ["default"], defaultMode: "default", setupActions: [] },
    ],
    projects: { items: [{ id: "matrix-os", label: "matrix-os", taskCount: 0, threadCount: 1, attentionCount: 0 }], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16384, maxAttachmentCount: 8, maxTerminalInputBytes: 8192, maxListItems: 20 },
    serverTime: at(0),
    ...overrides,
  });
}

function tab(tabId: string, overrides: Partial<TerminalTabFacts> = {}): TerminalTabFacts {
  return { ref: { workspaceId: WS, tabId }, name: "herdr-parity", cwd: "projects/matrix-os", projectId: "matrix-os", state: "live", ...overrides };
}

describe("agent inbox model", () => {
  it("groups threads by what they need and labels approval, question, failure, running and done", () => {
    const model = deriveAgentInbox({
      summary: summary({
        activeThreads: { items: [thread("thread_run"), thread("thread_approval", { status: "waiting_for_approval", attention: "approval_required" })], hasMore: false, limit: 20 },
        attentionThreads: { items: [
          thread("thread_approval", { status: "waiting_for_approval", attention: "approval_required" }),
          thread("thread_input", { status: "waiting_for_input", attention: "input_required", updatedAt: at(1) }),
          thread("thread_failed", { status: "failed", attention: "failed", updatedAt: at(40) }),
        ], hasMore: false, limit: 20 },
        recentThreads: { items: [thread("thread_done", { status: "completed", updatedAt: at(90) })], hasMore: false, limit: 10 },
      }),
    });
    expect(model.items.map((item) => [item.key, item.group, item.pill])).toEqual([
      ["thread:thread_input", "needs", "Question"],
      ["thread:thread_approval", "needs", "Approval"],
      ["thread:thread_failed", "needs", "Failed"],
      ["thread:thread_run", "running", "Running"],
      ["thread:thread_done", "done", "Done"],
    ]);
    expect(model.counts).toEqual({ all: 5, needs: 3, running: 1, done: 1 });
  });

  it("moves failures and stalls older than a day out of Needs you so old runs do not inflate the badge", () => {
    const model = deriveAgentInbox({
      summary: summary({
        attentionThreads: { items: [
          thread("thread_fresh_fail", { status: "failed", attention: "failed", updatedAt: at(60) }),
          thread("thread_old_fail", { status: "failed", attention: "failed", updatedAt: at(25 * 24 * 60) }),
          thread("thread_old_stale", { status: "stale", updatedAt: at(3 * 24 * 60) }),
          thread("thread_old_approval", { status: "waiting_for_approval", attention: "approval_required", updatedAt: at(5 * 24 * 60) }),
        ], hasMore: false, limit: 20 },
      }),
    });
    expect(model.items.map((item) => [item.key, item.group, item.pill])).toEqual([
      ["thread:thread_fresh_fail", "needs", "Failed"],
      ["thread:thread_old_approval", "needs", "Approval"],
      ["thread:thread_old_stale", "done", "Stalled"],
      ["thread:thread_old_fail", "done", "Failed"],
    ]);
    expect(model.counts.needs).toBe(2);
  });

  it("treats a run with no update for a day as stalled history, not running", () => {
    const model = deriveAgentInbox({
      summary: summary({
        activeThreads: { items: [
          thread("thread_live", { updatedAt: at(10) }),
          thread("thread_zombie", { updatedAt: at(73 * 24 * 60) }),
        ], hasMore: false, limit: 20 },
      }),
    });
    expect(model.items.map((item) => [item.key, item.group, item.pill])).toEqual([
      ["thread:thread_live", "running", "Running"],
      ["thread:thread_zombie", "done", "Stalled"],
    ]);
    expect(model.counts.running).toBe(1);
  });

  it("never shows the generic run title when the terminal tab or project says more", () => {
    const linked = thread("thread_linked", { providerId: "claude", projectId: "matrix-os", terminalRef: { workspaceId: WS, tabId: TAB_A } });
    const projectOnly = thread("thread_project", { projectId: "matrix-os" });
    const bare = thread("thread_bare");
    const model = deriveAgentInbox({
      summary: summary({ activeThreads: { items: [linked, projectOnly, bare], hasMore: false, limit: 20 } }),
      terminalTabs: { [`${WS}:${TAB_A}`]: tab(TAB_A, { name: "Herdr parity", agentStatus: "working", statusMessage: "Running tests" }) },
    });
    const byKey = Object.fromEntries(model.items.map((item) => [item.key, item]));
    expect(byKey["thread:thread_linked"]).toMatchObject({ title: "Herdr parity", avatar: "claude", subline: ["Claude Code", "matrix-os", "Running tests"] });
    expect(byKey["thread:thread_project"]!.title).toBe("Codex run in matrix-os");
    expect(byKey["thread:thread_bare"]!.title).toBe("Codex run");
    expect(model.items.some((item) => item.title === "Coding agent run")).toBe(false);
    // The thread and its tab are one agent, not two rows.
    expect(model.items).toHaveLength(3);
  });

  it("keeps a real thread title and opens threads by id, with their exact tab as a fallback", () => {
    const model = deriveAgentInbox({
      summary: summary({ activeThreads: { items: [thread("thread_named", { title: "Fix mobile composer warning", terminalRef: { workspaceId: WS, tabId: TAB_A } })], hasMore: false, limit: 20 } }),
    });
    expect(model.items[0]).toMatchObject({
      title: "Fix mobile composer warning",
      target: { kind: "thread", threadId: "thread_named", terminalKey: `${WS}:${TAB_A}` },
    });
  });

  it("moves a running thread to Needs you when its live tab is blocked, without a second row", () => {
    const model = deriveAgentInbox({
      summary: summary({
        activeThreads: { items: [thread("thread_blocked", { title: "Ship release notes", terminalRef: { workspaceId: WS, tabId: TAB_A } })], hasMore: false, limit: 20 },
        attentionThreads: { items: [thread("thread_approval", { status: "waiting_for_approval", attention: "approval_required", terminalRef: { workspaceId: WS, tabId: TAB_B } })], hasMore: false, limit: 20 },
      }),
      terminalTabs: {
        [`${WS}:${TAB_A}`]: tab(TAB_A, { agentStatus: "blocked", statusMessage: "Allow git push?", statusAt: at(0) }),
        [`${WS}:${TAB_B}`]: tab(TAB_B, { agentStatus: "blocked", statusMessage: "Run tests?", statusAt: at(0) }),
      },
    });
    expect(model.items).toHaveLength(2);
    expect(model.items.find((item) => item.key === "thread:thread_blocked")).toMatchObject({
      group: "needs", pill: "Needs you", message: "Allow git push?",
      target: { kind: "thread", threadId: "thread_blocked", terminalKey: `${WS}:${TAB_A}` },
    });
    // An explicit approval on the thread still wins over the tab's word.
    expect(model.items.find((item) => item.key === "thread:thread_approval")).toMatchObject({ group: "needs", pill: "Approval" });
    expect(model.counts).toMatchObject({ needs: 2, running: 0 });
  });

  it("shows Herdr terminal agents by status and opens their exact tab", () => {
    const model = deriveAgentInbox({
      summary: summary(),
      terminalTabs: {
        [`${WS}:${TAB_A}`]: tab(TAB_A, { name: "claude: Herdr parity", agentStatus: "blocked", statusMessage: "Allow git push?", statusAt: at(0) }),
        [`${WS}:${TAB_B}`]: tab(TAB_B, { name: "release-notes", agentStatus: "done", statusAt: at(60) }),
        idle: tab("tt_00000000000000000000000000000003", { name: "zsh", agentStatus: "idle" }),
        plain: tab("tt_00000000000000000000000000000004", { name: "vim" }),
        finished: tab("tt_00000000000000000000000000000005", { state: "finished", agentStatus: "done" }),
      },
    });
    expect(model.items).toEqual([
      expect.objectContaining({
        key: `terminal:${WS}:${TAB_A}`, group: "needs", pill: "Needs you", avatar: "claude",
        title: "claude: Herdr parity", subline: ["Terminal", "matrix-os"], message: "Allow git push?",
        target: { kind: "terminal", key: `${WS}:${TAB_A}` },
      }),
      expect.objectContaining({ key: `terminal:${WS}:${TAB_B}`, group: "done", pill: "Done", avatar: "agent" }),
    ]);
  });

  it("bounds each group and reports that more exist", () => {
    const tabs: Record<string, TerminalTabFacts> = {};
    for (let index = 0; index < 80; index += 1) {
      const tabId = `tt_${index.toString(16).padStart(32, "0")}`;
      tabs[`${WS}:${tabId}`] = tab(tabId, { name: `agent ${index}`, agentStatus: "working" });
    }
    const model = deriveAgentInbox({ summary: summary(), terminalTabs: tabs });
    expect(model.items.filter((item) => item.group === "running")).toHaveLength(30);
    expect(model.counts.running).toBe(80);
    expect(model.truncated).toBe(true);
  });

  it("formats relative times compactly", () => {
    const now = Date.parse("2026-11-16T12:00:00.000Z");
    expect(formatInboxTime(at(0), now)).toBe("now");
    expect(formatInboxTime(at(3), now)).toBe("3m");
    expect(formatInboxTime(at(125), now)).toBe("2h");
    expect(formatInboxTime(at(60 * 50), now)).toBe("2d");
    expect(formatInboxTime("not a date", now)).toBe("");
  });
});
