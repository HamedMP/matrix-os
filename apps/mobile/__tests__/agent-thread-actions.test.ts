import type { AgentThreadSnapshot } from "@matrix-os/contracts";
import { threadSnapshotFeedbackKey } from "../lib/agent-thread-actions";

type SnapshotFixtureOverrides = {
  thread?: Partial<AgentThreadSnapshot["thread"]>;
  events?: AgentThreadSnapshot["events"];
};

function snapshotFixture(overrides: SnapshotFixtureOverrides = {}): AgentThreadSnapshot {
  const base: AgentThreadSnapshot = {
    thread: {
      id: "thread_mobile",
      providerId: "codex",
      title: "Repair mobile route",
      status: "running",
      attention: "none",
      terminalSessionId: "matrix-abc1234",
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:01:00.000Z",
    },
    events: {
      items: [
        {
          eventId: "evt_mobile_1",
          threadId: "thread_mobile",
          type: "thread.status",
          status: "running",
          occurredAt: "2026-07-06T00:01:00.000Z",
        },
      ],
      hasMore: false,
      limit: 200,
    },
  };
  return {
    ...base,
    ...overrides,
    thread: {
      ...base.thread,
      ...overrides.thread,
    },
    events: overrides.events ?? base.events,
  };
}

describe("threadSnapshotFeedbackKey", () => {
  it("changes when a same-thread refresh replaces the accepted action snapshot", () => {
    const accepted = snapshotFixture({
      events: {
        items: [
          ...snapshotFixture().events.items,
          {
            eventId: "evt_mobile_approval_resolved",
            threadId: "thread_mobile",
            type: "approval.resolved",
            approvalId: "appr_mobile_1",
            decision: "approve",
            occurredAt: "2026-07-06T00:03:00.000Z",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    });
    const refreshed = snapshotFixture({
      thread: {
        updatedAt: "2026-07-06T00:04:00.000Z",
      },
    });

    expect(threadSnapshotFeedbackKey(accepted)).not.toBe(threadSnapshotFeedbackKey(refreshed));
  });

  it("does not include raw event payload text", () => {
    const snapshot = snapshotFixture({
      events: {
        items: [
          ...snapshotFixture().events.items,
          {
            eventId: "evt_mobile_assistant_text",
            threadId: "thread_mobile",
            type: "assistant.text.delta",
            messageId: "msg_mobile_1",
            delta: "token_sk_live_secret and /home/matrix/private",
            occurredAt: "2026-07-06T00:02:00.000Z",
          },
        ],
        hasMore: false,
        limit: 200,
      },
    });

    expect(threadSnapshotFeedbackKey(snapshot)).not.toMatch(/token|home\/matrix|private/i);
  });
});
