import { describe, expect, it } from "vitest";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { reconcileSummaryThread } from "../../desktop/src/renderer/src/stores/coding-agent/thread-model";

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
    terminalSessions: { items: [], hasMore: false, limit: 20 },
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
