import { describe, expect, it } from "vitest";
import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import type { AgentThread } from "../../desktop/src/renderer/src/stores/threads";
import {
  codingAgentAttentionCount,
  codingAgentThreadToUnified,
  kernelThreadAttentionCount,
  kernelThreadToUnified,
  listUnifiedThreads,
  routeThreadNotification,
  UNIFIED_THREAD_STATUS_META,
  unifiedAttentionCount,
} from "../../desktop/src/renderer/src/stores/unified-threads";

function kernelThread(overrides: Partial<AgentThread> = {}): AgentThread {
  return {
    id: "thread-1000-1",
    requestId: "request-1",
    sessionId: null,
    taskId: null,
    title: "Kernel run",
    status: "running",
    transcript: [],
    unread: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

function codingAgentThread(overrides: Partial<AgentThreadSummary> = {}): AgentThreadSummary {
  return {
    id: "thread_alpha",
    providerId: "codex",
    title: "Server run",
    status: "running",
    attention: "none",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:01:00.000Z",
    ...overrides,
  };
}

function runtimeSummary(overrides: Partial<RuntimeSummary> = {}): RuntimeSummary {
  return {
    runtime: { id: "rt_primary", label: "Primary", status: "available" },
    capabilities: [],
    providers: [],
    projects: { items: [], hasMore: false, limit: 20 },
    activeThreads: { items: [], hasMore: false, limit: 20 },
    attentionThreads: { items: [], hasMore: false, limit: 20 },
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

describe("kernelThreadToUnified", () => {
  it("keeps the kernel status vocabulary and epoch timestamps", () => {
    const item = kernelThreadToUnified(kernelThread({ status: "needs-attention", unread: true, updatedAt: 42 }));
    expect(item).toEqual({
      source: "kernel",
      id: "thread-1000-1",
      title: "Kernel run",
      status: "needs-attention",
      unread: true,
      updatedAt: 42,
    });
  });
});

describe("codingAgentThreadToUnified", () => {
  it("maps actionable attention to needs-attention regardless of status", () => {
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "waiting_for_approval", attention: "approval_required" })).status).toBe("needs-attention");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "waiting_for_input", attention: "input_required" })).status).toBe("needs-attention");
  });

  it("maps lifecycle statuses onto the unified vocabulary", () => {
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "queued" })).status).toBe("running");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "starting" })).status).toBe("running");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "running" })).status).toBe("running");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "completed", attention: "completed" })).status).toBe("done");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "failed", attention: "failed" })).status).toBe("failed");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "aborted" })).status).toBe("aborted");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "stale" })).status).toBe("aborted");
    expect(codingAgentThreadToUnified(codingAgentThread({ status: "archived" })).status).toBe("aborted");
  });

  it("marks only actionable attention as unread and parses ISO timestamps", () => {
    const actionable = codingAgentThreadToUnified(codingAgentThread({ attention: "approval_required", status: "waiting_for_approval" }));
    expect(actionable.unread).toBe(true);
    const finished = codingAgentThreadToUnified(codingAgentThread({ attention: "completed", status: "completed" }));
    expect(finished.unread).toBe(false);
    expect(actionable.updatedAt).toBe(Date.parse("2026-07-06T00:01:00.000Z"));
  });
});

describe("listUnifiedThreads", () => {
  it("merges kernel threads with active and attention coding-agent threads sorted by recency", () => {
    const summary = runtimeSummary();
    summary.activeThreads.items = [codingAgentThread({ id: "thread_old", updatedAt: "2026-07-06T00:00:30.000Z" })];
    summary.attentionThreads.items = [
      codingAgentThread({ id: "thread_hot", status: "waiting_for_approval", attention: "approval_required", updatedAt: "2026-07-06T00:02:00.000Z" }),
    ];
    const kernel = kernelThread({ id: "thread-1-1", updatedAt: Date.parse("2026-07-06T00:01:00.000Z") });

    const items = listUnifiedThreads([kernel], summary);

    expect(items.map((item) => item.id)).toEqual(["thread_hot", "thread-1-1", "thread_old"]);
    expect(items.map((item) => item.source)).toEqual(["coding-agent", "kernel", "coding-agent"]);
  });

  it("dedupes threads present in both active and attention lists preferring the attention entry", () => {
    const summary = runtimeSummary();
    summary.activeThreads.items = [codingAgentThread({ id: "thread_dup", status: "running", attention: "none" })];
    summary.attentionThreads.items = [
      codingAgentThread({ id: "thread_dup", status: "waiting_for_input", attention: "input_required" }),
    ];

    const items = listUnifiedThreads([], summary);

    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("needs-attention");
  });

  it("returns only kernel threads when there is no runtime summary", () => {
    const items = listUnifiedThreads([kernelThread()], null);
    expect(items).toHaveLength(1);
    expect(items[0]?.source).toBe("kernel");
  });
});

describe("attention counts", () => {
  it("counts kernel unread and needs-attention threads", () => {
    const threads = [
      kernelThread({ id: "a", unread: true }),
      kernelThread({ id: "b", status: "needs-attention" }),
      kernelThread({ id: "c" }),
    ];
    expect(kernelThreadAttentionCount(threads)).toBe(2);
  });

  it("counts coding-agent attention threads with the truncation cap", () => {
    const summary = runtimeSummary();
    summary.attentionThreads.items = [codingAgentThread({ id: "thread_a" }), codingAgentThread({ id: "thread_b" })];
    expect(codingAgentAttentionCount(summary)).toBe(2);
    summary.attentionThreads.hasMore = true;
    expect(codingAgentAttentionCount(summary)).toBe(999);
    expect(codingAgentAttentionCount(null)).toBe(0);
  });

  it("sums both systems in the unified count", () => {
    const summary = runtimeSummary();
    summary.attentionThreads.items = [codingAgentThread({ id: "thread_a" })];
    expect(unifiedAttentionCount([kernelThread({ unread: true })], summary)).toBe(2);
  });
});

describe("routeThreadNotification", () => {
  it("routes ids present in the kernel store to the chat surface", () => {
    expect(routeThreadNotification("thread-1000-1", ["thread-1000-1"])).toEqual({ target: "chat", select: "thread-1000-1" });
  });

  it("routes server-namespace ids to the coding-agent surface", () => {
    expect(routeThreadNotification("thread_alpha", [])).toEqual({ target: "coding-agent", select: "thread_alpha" });
  });

  it("routes stale kernel-format ids to chat without a selection", () => {
    expect(routeThreadNotification("thread-999-9", [])).toEqual({ target: "chat", select: null });
  });
});

describe("UNIFIED_THREAD_STATUS_META", () => {
  it("defines a label and color for every unified status", () => {
    for (const status of ["running", "needs-attention", "done", "failed", "aborted"] as const) {
      expect(UNIFIED_THREAD_STATUS_META[status].label.length).toBeGreaterThan(0);
      expect(UNIFIED_THREAD_STATUS_META[status].color).toMatch(/^var\(--/);
    }
  });
});
