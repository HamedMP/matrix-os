import { describe, expect, it } from "vitest";
import type {
  AgentThreadEvent,
  AgentThreadSnapshot,
  AgentThreadSummary,
  RuntimeSummary,
} from "@matrix-os/contracts";
import {
  mergeLiveThreadEvent,
  mergeSelectedThreadSnapshot,
  reconcileSummaryThread,
} from "../../desktop/src/renderer/src/stores/coding-agent/thread-model";

function thread(overrides: Partial<AgentThreadSummary> = {}): AgentThreadSummary {
  return {
    id: "thread_alpha",
    providerId: "codex",
    title: "Run",
    status: "running",
    attention: "none",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:01:00.000Z",
    ...overrides,
  };
}

function summary(overrides: {
  active?: AgentThreadSummary[];
  attention?: AgentThreadSummary[];
  attentionLimit?: number;
  attentionHasMore?: boolean;
} = {}): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: overrides.active ?? [], hasMore: false, limit: 20 },
    attentionThreads: {
      items: overrides.attention ?? [],
      hasMore: overrides.attentionHasMore ?? false,
      limit: overrides.attentionLimit ?? 20,
    },
    terminalWorkspaces: { items: [], hasMore: false, limit: 20 },
    recentActivity: { items: [], hasMore: false, limit: 20 },
    limits: {
      maxPromptBytes: 16384,
      maxAttachmentCount: 8,
      maxTerminalInputBytes: 8192,
      maxListItems: 20,
    },
    serverTime: "2026-07-06T00:03:00.000Z",
  } as RuntimeSummary;
}

function threadSnapshot(events: AgentThreadEvent[] = [], threadId = "thread_alpha"): AgentThreadSnapshot {
  return {
    thread: thread({ id: threadId }),
    events: {
      items: events,
      hasMore: false,
      limit: 200,
    },
  };
}

function assistantDelta(
  eventId: string,
  delta: string,
  options: { messageId?: string; threadId?: string; occurredAt?: string } = {},
): AgentThreadEvent {
  return {
    type: "assistant.text.delta",
    eventId,
    threadId: options.threadId ?? "thread_alpha",
    occurredAt: options.occurredAt ?? "2026-07-06T00:02:00.000Z",
    messageId: options.messageId ?? "msg_alpha",
    delta,
  };
}

describe("thread event projection", () => {
  it("preserves sequential same-timestamp deltas in Gateway arrival order without mutating prior snapshots", () => {
    const initial = threadSnapshot();
    const first = assistantDelta("evt_z", "first ");
    const second = assistantDelta("evt_a", "second");

    const afterFirst = mergeLiveThreadEvent(initial, first);
    const afterSecond = mergeLiveThreadEvent(afterFirst, second);

    expect(afterSecond.events.items.map((event) => event.eventId)).toEqual(["evt_z", "evt_a"]);
    expect(afterSecond.events.items.map((event) => event.type === "assistant.text.delta" ? event.delta : "").join(""))
      .toBe("first second");
    expect(initial.events.items).toEqual([]);
    expect(afterFirst.events.items).toEqual([first]);
  });

  it("preserves tool and assistant interleaving instead of sorting opaque event IDs", () => {
    const occurredAt = "2026-07-06T00:02:00.000Z";
    const events: AgentThreadEvent[] = [
      assistantDelta("evt_z", "before", { occurredAt }),
      {
        type: "tool.started",
        eventId: "evt_y",
        threadId: "thread_alpha",
        occurredAt,
        toolCallId: "tool_alpha",
        displayName: "Read file",
        kind: "read",
      },
      {
        type: "tool.output",
        eventId: "evt_x",
        threadId: "thread_alpha",
        occurredAt,
        toolCallId: "tool_alpha",
        text: "result",
      },
      assistantDelta("evt_w", "after", { occurredAt }),
    ];

    const projected = events.reduce(mergeLiveThreadEvent, threadSnapshot());

    expect(projected.events.items.map((event) => event.eventId))
      .toEqual(["evt_z", "evt_y", "evt_x", "evt_w"]);
  });

  it("treats a duplicate event identity as an idempotent no-op", () => {
    const first = assistantDelta("evt_same", "canonical");
    const current = mergeLiveThreadEvent(threadSnapshot(), first);

    const duplicate = mergeLiveThreadEvent(current, { ...first, delta: "corrupted duplicate" });

    expect(duplicate).toBe(current);
    expect(duplicate.events.items).toEqual([first]);
  });

  it("lets authoritative snapshot order replace a divergent live order", () => {
    const first = assistantDelta("evt_z", "first ");
    const second = assistantDelta("evt_a", "second");
    const divergentLive = threadSnapshot([second, first]);
    const authoritativeReload = threadSnapshot([first, second]);

    const reconciled = mergeSelectedThreadSnapshot(divergentLive, authoritativeReload);

    expect(reconciled.events.items.map((event) => event.eventId)).toEqual(["evt_z", "evt_a"]);
    expect(authoritativeReload.events.items).toEqual([first, second]);
  });

  it("reconciles a stale reconnect snapshot before retaining unseen live tail events", () => {
    const first = assistantDelta("evt_z", "first ");
    const second = assistantDelta("evt_y", "second ");
    const unseenLive = assistantDelta("evt_a", "third");
    const current = threadSnapshot([first, second, unseenLive]);
    const staleSnapshot = threadSnapshot([first, second]);

    const reconciled = mergeSelectedThreadSnapshot(current, staleSnapshot);

    expect(reconciled.events.items.map((event) => event.eventId)).toEqual(["evt_z", "evt_y", "evt_a"]);
    expect(reconciled.events.items).toHaveLength(3);
  });

  it("keeps a newer live window when a stale bounded snapshot no longer overlaps it", () => {
    const live = {
      ...threadSnapshot([assistantDelta("evt_live", "new")]),
      thread: thread({ updatedAt: "2026-07-06T00:03:00.000Z" }),
    };
    const stale = {
      ...threadSnapshot([assistantDelta("evt_stale", "old")]),
      thread: thread({ updatedAt: "2026-07-06T00:02:00.000Z" }),
    };

    const reconciled = mergeSelectedThreadSnapshot(live, stale);

    expect(reconciled.events.items.map((event) => event.eventId)).toEqual(["evt_live"]);
    expect(reconciled.thread.updatedAt).toBe("2026-07-06T00:03:00.000Z");
  });

  it("ignores a stale event from a previously selected thread", () => {
    const current = threadSnapshot([], "thread_beta");
    const stale = assistantDelta("evt_old", "stale", { threadId: "thread_alpha" });

    expect(mergeLiveThreadEvent(current, stale)).toBe(current);
  });
});

describe("reconcileSummaryThread", () => {
  it("updates a thread in place in both lists", () => {
    const stale = thread({ status: "waiting_for_approval", attention: "approval_required" });
    const next = thread({ status: "running", attention: "approval_required", updatedAt: "2026-07-06T00:02:00.000Z" });
    const result = reconcileSummaryThread(summary({ active: [stale], attention: [stale] }), next);

    expect(result.activeThreads.items).toEqual([next]);
    expect(result.attentionThreads.items).toEqual([next]);
  });

  it("removes a thread from the attention list when attention drops to none", () => {
    const attending = thread({ status: "waiting_for_approval", attention: "approval_required" });
    const resolved = thread({ status: "running", attention: "none", updatedAt: "2026-07-06T00:02:00.000Z" });
    const result = reconcileSummaryThread(summary({ active: [attending], attention: [attending] }), resolved);

    expect(result.attentionThreads.items).toEqual([]);
    expect(result.activeThreads.items).toEqual([resolved]);
  });

  it("promotes a thread into the attention list when a live event raises attention", () => {
    const calm = thread({ status: "running", attention: "none" });
    const raised = thread({ status: "waiting_for_approval", attention: "approval_required", updatedAt: "2026-07-06T00:02:00.000Z" });
    const result = reconcileSummaryThread(summary({ active: [calm], attention: [] }), raised);

    expect(result.attentionThreads.items).toEqual([raised]);
    expect(result.attentionThreads.hasMore).toBe(false);
    expect(result.activeThreads.items).toEqual([raised]);
  });

  it("does not promote archived threads even when their attention is set", () => {
    const archived = thread({
      id: "thread_archived",
      status: "archived",
      attention: "completed",
      updatedAt: "2026-07-06T00:02:00.000Z",
    });
    const result = reconcileSummaryThread(summary({ attention: [] }), archived);

    expect(result.attentionThreads.items).toEqual([]);
  });

  it("does not duplicate an already-listed attention thread on promotion", () => {
    const raised = thread({ status: "waiting_for_input", attention: "input_required" });
    const result = reconcileSummaryThread(summary({ active: [raised], attention: [raised] }), raised);

    expect(result.attentionThreads.items).toHaveLength(1);
  });

  it("enforces the attention list limit on promotion and marks truncation", () => {
    const existing = [
      thread({ id: "thread_one", status: "waiting_for_approval", attention: "approval_required" }),
      thread({ id: "thread_two", status: "waiting_for_input", attention: "input_required" }),
    ];
    const raised = thread({ id: "thread_new", status: "waiting_for_approval", attention: "approval_required", updatedAt: "2026-07-06T00:05:00.000Z" });
    const result = reconcileSummaryThread(summary({ attention: existing, attentionLimit: 2 }), raised);

    expect(result.attentionThreads.items).toHaveLength(2);
    expect(result.attentionThreads.items[0]).toEqual(raised);
    expect(result.attentionThreads.hasMore).toBe(true);
  });

  it("preserves an existing truncation marker on unrelated updates", () => {
    const listed = thread({ id: "thread_listed", status: "waiting_for_approval", attention: "approval_required" });
    const updated = { ...listed, updatedAt: "2026-07-06T00:06:00.000Z" };
    const result = reconcileSummaryThread(summary({ attention: [listed], attentionHasMore: true }), updated);

    expect(result.attentionThreads.hasMore).toBe(true);
    expect(result.attentionThreads.items).toEqual([updated]);
  });
});
