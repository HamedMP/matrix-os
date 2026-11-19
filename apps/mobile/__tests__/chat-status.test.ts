import type { CanonicalChatRecord } from "@matrix-os/contracts";

import { chatStatus } from "../lib/chat-status";

type Chat = CanonicalChatRecord["chat"];

function record(overrides: {
  attention?: Chat["attention"];
  activeRun?: CanonicalChatRecord["activeRun"];
  readState?: CanonicalChatRecord["readState"];
  latestSuccessfulCompletion?: CanonicalChatRecord["latestSuccessfulCompletion"];
} = {}): CanonicalChatRecord {
  return {
    chat: {
      id: "chat-1",
      ownerScope: { type: "personal", ownerId: "user_a" },
      title: "Release notes",
      lifecycle: "active",
      attention: overrides.attention ?? "none",
      revision: 1,
      messageCount: 2,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    } as Chat,
    ...(overrides.activeRun ? { activeRun: overrides.activeRun } : {}),
    ...(overrides.readState ? { readState: overrides.readState } : {}),
    ...(overrides.latestSuccessfulCompletion ? { latestSuccessfulCompletion: overrides.latestSuccessfulCompletion } : {}),
  };
}

function run(status: NonNullable<CanonicalChatRecord["activeRun"]>["status"]): CanonicalChatRecord["activeRun"] {
  return { runId: "run_1", turnId: "turn_1", status } as CanonicalChatRecord["activeRun"];
}

const unread = { unread: true, markedUnread: false, version: 1, readThroughSeq: 1, latestIncomingSeq: 2 };
const read = { unread: false, markedUnread: false, version: 2, readThroughSeq: 2, latestIncomingSeq: 2 };

describe("chatStatus", () => {
  it("words a run that is under way as Working, with the green dot", () => {
    expect(chatStatus(record({ activeRun: run("running") }))).toEqual({ state: "running", label: "Working…", tone: "active" });
    expect(chatStatus(record({ activeRun: run("accepted") }))?.label).toBe("Working…");
  });

  it("asks for approval when the chat or its run waits on one, with the amber dot", () => {
    const expected = { state: "approval_required", label: "Approval required", tone: "waiting" };
    expect(chatStatus(record({ attention: "approval_required" }))).toEqual(expected);
    // The run can be waiting before the chat's own attention has caught up.
    expect(chatStatus(record({ activeRun: run("waiting_for_approval") }))).toEqual(expected);
  });

  it("asks for a reply when the chat or its run waits on one", () => {
    expect(chatStatus(record({ attention: "input_required" }))).toEqual({
      state: "input_required", label: "Waiting for your reply", tone: "waiting",
    });
    expect(chatStatus(record({ activeRun: run("waiting_for_input") }))?.state).toBe("input_required");
  });

  it("flags a failed run as needing attention", () => {
    expect(chatStatus(record({ attention: "failed" }))).toEqual({ state: "failed", label: "Needs attention", tone: "waiting" });
  });

  it("puts approval ahead of a run that is still going", () => {
    expect(chatStatus(record({ attention: "approval_required", activeRun: run("running") }))?.state).toBe("approval_required");
  });

  it("marks a finished run nobody has read yet as Completed", () => {
    expect(chatStatus(record({ readState: unread }))).toEqual({ state: "unseen_completion", label: "Completed", tone: "unread" });
    expect(chatStatus(record({
      latestSuccessfulCompletion: { runId: "run_1", completedAt: "2026-01-01T00:00:00.000Z", unacknowledged: true },
    }))?.state).toBe("unseen_completion");
  });

  it("shows nothing for a chat that is read and idle", () => {
    expect(chatStatus(record())).toBeNull();
    expect(chatStatus(record({
      readState: read,
      latestSuccessfulCompletion: { runId: "run_1", completedAt: "2026-01-01T00:00:00.000Z", unacknowledged: false },
    }))).toBeNull();
  });
});
