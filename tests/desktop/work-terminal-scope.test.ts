import { describe, expect, it } from "vitest";
import type {
  CanonicalChatDetailResponse,
  CanonicalChatRunActivity,
  RuntimeSummary,
  TerminalSessionSummary,
} from "@matrix-os/contracts";
import { projectWorkTerminalSessions } from "@desktop/renderer/src/features/work/work-terminal-scope";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";

const NOW = "2026-08-28T10:00:00.000Z";
const { snapshot } = createCanonicalChatFixture("completed");

function binding(id: string, terminalSessionId: string, occurredAt: string): CanonicalChatRunActivity {
  return {
    id,
    chatId: snapshot.chat.id,
    runId: snapshot.runs[0]!.id,
    occurredAt,
    type: "terminal.bound",
    terminalSessionId,
  };
}

function detail(activities: CanonicalChatRunActivity[]): CanonicalChatDetailResponse {
  return {
    record: snapshot,
    messages: snapshot.messages,
    turns: snapshot.turns,
    runs: snapshot.runs,
    activities,
  };
}

function session(id: string, partial: Partial<TerminalSessionSummary> = {}): TerminalSessionSummary {
  return {
    id,
    name: id,
    status: "running",
    attachable: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...partial,
  };
}

function summary(items: TerminalSessionSummary[]): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
    terminalSessions: { items, hasMore: false, limit: 50 },
    previewSessions: { items: [], hasMore: false, limit: 50 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: { maxPromptBytes: 16_384, maxAttachmentCount: 8, maxTerminalInputBytes: 8_192, maxListItems: 20 },
    serverTime: NOW,
  };
}

describe("Work terminal projection", () => {
  it("keeps only selected-Chat bindings, newest first, and de-duplicates by session id", () => {
    const result = projectWorkTerminalSessions(detail([
      binding("activity_old", "terminal_build", "2026-08-28T08:00:00.000Z"),
      binding("activity_other", "terminal_deploy", "2026-08-28T09:00:00.000Z"),
      binding("activity_new", "terminal_build", "2026-08-28T10:00:00.000Z"),
    ]), summary([
      session("terminal_unrelated"),
      session("terminal_build", { name: "Build" }),
      session("terminal_deploy", { name: "Deploy" }),
    ]));

    expect(result.map((item) => item.id)).toEqual(["terminal_build", "terminal_deploy"]);
    expect(result.map((item) => item.name)).toEqual(["Build", "Deploy"]);
  });

  it("shows a persisted binding as unavailable without borrowing another runtime session", () => {
    expect(projectWorkTerminalSessions(
      detail([binding("activity_missing", "terminal_missing", "2026-08-28T10:00:00.000Z")]),
      summary([session("terminal_unrelated")]),
    )).toEqual([
      expect.objectContaining({
        id: "terminal_missing",
        name: "terminal_missing",
        status: "unavailable",
        attachable: false,
      }),
    ]);
  });

  it("keeps persisted bindings visible as unavailable before a runtime summary exists", () => {
    expect(projectWorkTerminalSessions(
      detail([binding("activity_pending", "terminal_pending", "2026-08-28T10:00:00.000Z")]),
      null,
    )).toEqual([
      expect.objectContaining({
        id: "terminal_pending",
        status: "unavailable",
        attachable: false,
      }),
    ]);
  });

  it("changes projection with the selected Chat detail instead of retaining prior bindings", () => {
    const runtime = summary([session("terminal_first"), session("terminal_second")]);
    const first = projectWorkTerminalSessions(
      detail([binding("activity_first", "terminal_first", "2026-08-28T09:00:00.000Z")]),
      runtime,
    );
    const second = projectWorkTerminalSessions(
      detail([binding("activity_second", "terminal_second", "2026-08-28T10:00:00.000Z")]),
      runtime,
    );

    expect(first.map((item) => item.id)).toEqual(["terminal_first"]);
    expect(second.map((item) => item.id)).toEqual(["terminal_second"]);
  });
});
