import type { AgentThreadSummary, RuntimeSummary } from "@matrix-os/contracts";
import { buildAgentCockpit } from "../lib/agent-cockpit";

function thread(overrides: Partial<AgentThreadSummary>): AgentThreadSummary {
  return {
    id: "thread_default",
    providerId: "codex",
    title: "Default run",
    status: "running",
    attention: "none",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:01:00.000Z",
    ...overrides,
  };
}

function summaryLists(
  activeThreads: AgentThreadSummary[],
  attentionThreads: AgentThreadSummary[],
): Pick<RuntimeSummary, "activeThreads" | "attentionThreads"> {
  return {
    activeThreads: { items: activeThreads, hasMore: false, limit: 20 },
    attentionThreads: { items: attentionThreads, hasMore: false, limit: 20 },
  };
}

describe("buildAgentCockpit", () => {
  it("deduplicates gateway attention threads and removes them from working", () => {
    const approval = thread({
      id: "thread_approval",
      title: "Approve deployment",
      status: "waiting_for_approval",
      attention: "approval_required",
    });
    const working = thread({ id: "thread_working", title: "Build mobile cockpit" });

    const model = buildAgentCockpit(summaryLists([approval, working], [approval]));

    expect(model.needsAttention.map((item) => item.id)).toEqual(["thread_approval"]);
    expect(model.working.map((item) => item.id)).toEqual(["thread_working"]);
  });

  it("prioritizes approvals, input requests, and failures before recency", () => {
    const model = buildAgentCockpit(summaryLists([], [
      thread({ id: "thread_failed", attention: "failed", status: "failed", updatedAt: "2026-07-06T00:12:00.000Z" }),
      thread({ id: "thread_input", attention: "input_required", status: "waiting_for_input", updatedAt: "2026-07-06T00:11:00.000Z" }),
      thread({ id: "thread_approval", attention: "approval_required", status: "waiting_for_approval", updatedAt: "2026-07-06T00:10:00.000Z" }),
    ]));

    expect(model.needsAttention.map((item) => item.id)).toEqual([
      "thread_approval",
      "thread_input",
      "thread_failed",
    ]);
  });
});
