import { describe, expect, it } from "vitest";
import {
  projectConversationAgents,
  projectConversationCounts,
  projectConversationPlacement,
  queryProjectConversations,
  toProjectConversationRow,
} from "../../packages/ui/src/chat/project-conversations";
import { chatRecord, run } from "./project-conversation-fixtures";


describe("project conversation status", () => {
  it("uses the agent inbox vocabulary for every canonical Chat state", () => {
    expect(projectConversationPlacement(chatRecord("a", { activeRun: run("waiting_for_approval") }))).toEqual({ group: "needs", pill: "Approval" });
    expect(projectConversationPlacement(chatRecord("b", { chat: { attention: "input_required" } }))).toEqual({ group: "needs", pill: "Question" });
    expect(projectConversationPlacement(chatRecord("c", { chat: { attention: "failed" } }))).toEqual({ group: "needs", pill: "Failed" });
    expect(projectConversationPlacement(chatRecord("d", { activeRun: run("running") }))).toEqual({ group: "running", pill: "Running" });
    expect(projectConversationPlacement(chatRecord("e", { activeRun: run("accepted") }))).toEqual({ group: "running", pill: "Running" });
    expect(projectConversationPlacement(chatRecord("f"))).toEqual({ group: "done", pill: "Done" });
  });

  it("shows a new run as Running even when the previous run failed", () => {
    expect(projectConversationPlacement(chatRecord("a", { chat: { attention: "failed" }, activeRun: run("running") })))
      .toEqual({ group: "running", pill: "Running" });
  });
});

describe("project conversation rows", () => {
  it("names the bound agent and its shipped artwork", () => {
    const row = toProjectConversationRow(chatRecord("a", { driverKind: "claude_code" }));
    expect(row).toMatchObject({ agent: "claude_code", agentLabel: "Claude Code", artwork: "claude" });
    expect(toProjectConversationRow(chatRecord("b"))).toMatchObject({ agent: "agent", agentLabel: "Agent" });
    expect(toProjectConversationRow(chatRecord("b")).artwork).toBeUndefined();
  });

  it("bounds the snippet and falls back to the Chat's own preview", () => {
    const long = "x".repeat(400);
    expect(toProjectConversationRow(chatRecord("a"), long).snippet).toHaveLength(160);
    const withPreview = chatRecord("b");
    (withPreview.chat as Record<string, unknown>).lastMessagePreview = "Pushed the fix";
    expect(toProjectConversationRow(withPreview).snippet).toBe("Pushed the fix");
    expect(toProjectConversationRow(chatRecord("c")).snippet).toBeUndefined();
  });
});

describe("project conversation query", () => {
  const rows = [
    toProjectConversationRow(chatRecord("1", { chat: { title: "beta deploy", activityAt: "2026-11-12T00:00:00.000Z", createdAt: "2026-11-01T00:00:00.000Z" }, driverKind: "codex" })),
    toProjectConversationRow(chatRecord("2", { chat: { title: "Alpha fix", activityAt: "2026-11-11T00:00:00.000Z", createdAt: "2026-11-05T00:00:00.000Z" }, activeRun: run("running"), driverKind: "claude_code" })),
    toProjectConversationRow(chatRecord("3", { chat: { title: "Gamma docs", activityAt: "2026-11-13T00:00:00.000Z", createdAt: "2026-11-03T00:00:00.000Z", attention: "approval_required" }, driverKind: "codex" })),
  ];
  const base = { search: "", status: "all", agent: "all", sort: "activity" } as const;
  const ids = (query: Parameters<typeof queryProjectConversations>[1]) => queryProjectConversations(rows, query).map((row) => row.id);

  it("sorts by last activity by default, then created, then title", () => {
    expect(ids(base)).toEqual(["3", "1", "2"]);
    expect(ids({ ...base, sort: "created" })).toEqual(["2", "3", "1"]);
    expect(ids({ ...base, sort: "title" })).toEqual(["2", "1", "3"]);
  });

  it("searches titles case-insensitively and filters by status and agent", () => {
    expect(ids({ ...base, search: "ALPHA" })).toEqual(["2"]);
    expect(ids({ ...base, status: "needs" })).toEqual(["3"]);
    expect(ids({ ...base, status: "running" })).toEqual(["2"]);
    expect(ids({ ...base, agent: "codex" })).toEqual(["3", "1"]);
  });

  it("counts groups and lists distinct agents", () => {
    expect(projectConversationCounts(rows)).toEqual({ all: 3, needs: 1, running: 1, done: 1 });
    expect(projectConversationAgents(rows)).toEqual([{ value: "codex", label: "Codex" }, { value: "claude_code", label: "Claude Code" }]);
  });
});
