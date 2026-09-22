import { describe, expect, it } from "vitest";
import { createCodexSubagentActivity } from "../../packages/gateway/src/coding-agents/codex-subagent-activity.mjs";
import { parseCodexExecJsonLine } from "../../packages/gateway/src/coding-agents/codex-events.js";

function marker(kind = "started", id = "start") {
  return { method: "item/completed", params: { threadId: "parent", turnId: "turn", item: {
    type: "subAgentActivity", id, kind, agentThreadId: "child", agentPath: "/root/research",
  } } };
}

describe("Codex subagent attribution", () => {
  it("keeps a completed spawn marker running until the child actually finishes", () => {
    const tracker = createCodexSubagentActivity();
    const started = tracker.project(marker(), "parent", "turn");
    expect(started).toHaveLength(1);
    expect(started[0].subagent).toMatchObject({ name: "research", status: "running" });
    expect(tracker.project(marker(), "parent", "turn")).toEqual([]);
    const completed = tracker.project({ method: "turn/completed", params: { threadId: "child", turn: {
      id: "child-turn", status: "completed", items: [{ type: "agentMessage", text: "Found the regression.", phase: "final_answer" }],
    } } }, "parent", "turn");
    expect(completed[0]).toMatchObject({ activityId: started[0].activityId,
      subagent: { status: "completed", result: "Found the regression." } });
    const events = parseCodexExecJsonLine(JSON.stringify(completed[0]), {
      threadId: "thread_matrix", now: () => new Date("2026-09-21T10:00:00Z"), nextEventId: () => "evt_child",
    });
    expect(events.events[0]).toMatchObject({ type: "subagent.activity", subagent: { status: "completed" } });
  });

  it("projects waiting and failure without exposing native identities or errors", () => {
    const tracker = createCodexSubagentActivity();
    tracker.project(marker(), "parent", "turn");
    const waiting = tracker.project({ method: "thread/status/changed", params: {
      threadId: "child", status: { type: "active", activeFlags: ["waitingOnApproval"] },
    } }, "parent", "turn");
    expect(waiting[0].subagent.status).toBe("waiting");
    const failed = tracker.project({ method: "turn/completed", params: { threadId: "child", turn: {
      id: "child-turn", status: "failed", error: { message: "Bearer secret" }, items: [],
    } } }, "parent", "turn");
    expect(failed[0].subagent.status).toBe("failed");
    expect(JSON.stringify(failed)).not.toMatch(/Bearer|child-turn|\/root/);
    expect(tracker.project({ method: "thread/status/changed", params: {
      threadId: "unrelated", status: { type: "systemError" },
    } }, "parent", "turn")).toEqual([]);
  });

  it("uses receiver state rather than the legacy collaboration tool outcome", () => {
    const tracker = createCodexSubagentActivity();
    const events = tracker.project({ method: "item/completed", params: { threadId: "parent", turnId: "turn", item: {
      type: "collabAgentToolCall", id: "spawn", tool: "spawnAgent", status: "completed",
      senderThreadId: "parent", receiverThreadIds: ["child"], prompt: "Review the change", agentsStates: { child: { status: "running" } },
    } } }, "parent", "turn");
    expect(events[0].subagent).toMatchObject({ status: "running", task: "Review the change" });
  });

  it("bounds tracked children, rejects malformed markers, and resets between runs", () => {
    const tracker = createCodexSubagentActivity({ maxAgents: 2 });
    for (let i = 0; i < 4; i++) {
      const event = marker(); event.params.item.agentThreadId = `child-${i}`;
      tracker.project(event, "parent", "turn");
    }
    expect(tracker.size).toBe(2);
    tracker.reset();
    expect(tracker.size).toBe(0);
    expect(tracker.project({ ...marker(), params: { ...marker().params, threadId: "other" } }, "parent", "turn")).toEqual([]);
  });
});


it("accepts the runtime completed marker without treating spawn completion as success", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  expect(tracker.project(marker("completed", "done"), "parent", "turn")[0].subagent.status).toBe("completed");
});

it("ignores stale child turns and clears stale results on another child turn", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  tracker.project({ method: "turn/started", params: { threadId: "child", turn: { id: "new" } } }, "parent", "turn");
  expect(tracker.project({ method: "turn/completed", params: { threadId: "child", turn: { id: "old", status: "completed" } } }, "parent", "turn")).toEqual([]);
  const current = tracker.project({ method: "item/started", params: { threadId: "child", turnId: "new", item: { id: "cmd", type: "commandExecution", command: "cat /private/auth.json" } } }, "parent", "turn");
  expect(current[0].subagent.activity).toBe("Running a command");
  expect(JSON.stringify(current)).not.toContain("auth.json");
});

it("preserves identity when optional task or result metadata cannot be displayed", () => {
  const result = parseCodexExecJsonLine(JSON.stringify({ type: "matrix.codex.subagent.activity", activityId: "agent_activity", subagent: {
    agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "completed",
    task: "read /Users/private/.env", result: "Bearer secret",
  } }), { threadId: "thread_matrix", now: () => new Date(), nextEventId: () => "evt_child" });
  expect(result.events[0]).toMatchObject({ type: "subagent.activity", subagent: { name: "Research", status: "completed" } });
  expect(JSON.stringify(result)).not.toMatch(/private|Bearer/);
});

it("attributes nested children only to an observed active child turn", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  const nested = { method: "item/completed", params: { threadId: "child", turnId: "child-turn", item: {
    type: "subAgentActivity", id: "nested", kind: "started", agentThreadId: "grandchild", agentPath: "/root/research/tests",
  } } };
  expect(tracker.project(nested, "parent", "turn")).toEqual([]);
  tracker.project({ method: "turn/started", params: { threadId: "child", turn: { id: "child-turn" } } }, "parent", "turn");
  expect(tracker.project(nested, "parent", "turn")[0].subagent).toMatchObject({ name: "tests", parentName: "research", status: "running" });
  tracker.reset();
  expect(tracker.project(nested, "parent", "another-turn")).toEqual([]);
});

it("does not retain a previous result while a legacy child is working again", () => {
  const tracker = createCodexSubagentActivity();
  const legacy = (status: string, message?: string) => ({ method: "item/completed", params: { threadId: "parent", turnId: "turn", item: {
    type: "collabAgentToolCall", id: "wait", senderThreadId: "parent", receiverThreadIds: ["child"], agentsStates: { child: { status, message } },
  } } });
  tracker.project(legacy("completed", "Previous answer"), "parent", "turn");
  const running = tracker.project(legacy("running"), "parent", "turn");
  expect(running[0].subagent.result).toBeUndefined();
});


it("accepts role metadata only for an already attributed child", () => {
  const tracker = createCodexSubagentActivity();
  const metadata = { method: "thread/started", params: { thread: { id: "child", agentRole: "explorer" } } };
  expect(tracker.project(metadata, "parent", "turn")).toEqual([]);
  tracker.project(marker(), "parent", "turn");
  const event = tracker.project(metadata, "parent", "turn")[0];
  expect(event.subagent.role).toBe("explorer");
  expect(parseCodexExecJsonLine(JSON.stringify(event), { threadId: "thread_matrix", now: () => new Date(), nextEventId: () => "evt_role" }).events[0]).toMatchObject({ subagent: { role: "explorer" } });
  expect(tracker.project({ ...metadata, params: { thread: { id: "child", agentRole: "Bearer secret" } } }, "parent", "turn")).toEqual([]);
});


it("withholds natural-language credentials in child results before persistence", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  const events = tracker.project({ method: "turn/completed", params: { threadId: "child", turn: {
    status: "completed", items: [{ type: "agentMessage", phase: "final_answer", text: "the password is example-sensitive-value" }],
  } } }, "parent", "turn");
  expect(events[0].subagent.status).toBe("completed");
  expect(events[0].subagent.result).toBeUndefined();
});

it("hydrates only an attributed child's matching parent and bounds metadata reads", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual(["child"]);
  expect(tracker.takeMetadataRequests()).toEqual([]);
  expect(tracker.projectMetadata("child", { id: "child", parentThreadId: "unrelated", agentRole: "worker" }, "parent", "turn")).toEqual([]);
  expect(tracker.projectMetadata("child", { id: "other", parentThreadId: "parent", agentRole: "worker" }, "parent", "turn")).toEqual([]);
  expect(tracker.projectMetadata("child", { id: "child", parentThreadId: "parent", agentRole: "explorer" }, "parent", "turn")[0].subagent.role).toBe("explorer");
  for (let i = 0; i < 140; i++) {
    const event = marker(); event.params.item.agentThreadId = `child-${i}`;
    tracker.project(event, "parent", "turn");
  }
  expect(tracker.takeMetadataRequests()).toHaveLength(127);
  expect(tracker.projectMetadata("child", { id: "child", parentThreadId: "parent", agentRole: "worker" }, "parent", "turn")).toEqual([]);
  tracker.reset();
  expect(tracker.takeMetadataRequests()).toEqual([]);
});


it("rechecks missing role metadata once when a child completes", () => {
  const tracker = createCodexSubagentActivity();
  tracker.project(marker(), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual(["child"]);
  expect(tracker.projectMetadata("child", { id: "child", parentThreadId: "parent", agentRole: null }, "parent", "turn")).toEqual([]);
  tracker.project(marker("completed", "done"), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual(["child"]);
  tracker.project(marker("completed", "done"), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual([]);
  const result = tracker.projectMetadata("child", { id: "child", parentThreadId: "parent", agentRole: "worker" }, "parent", "turn");
  expect(result[0].subagent).toMatchObject({ role: "worker", status: "completed" });
  tracker.project(marker("completed", "done"), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual([]);
});


it("does not re-read a known role and caps completion rechecks across eviction", () => {
  const tracker = createCodexSubagentActivity({ maxAgents: 2 });
  tracker.project(marker(), "parent", "turn");
  tracker.takeMetadataRequests();
  tracker.projectMetadata("child", { id: "child", parentThreadId: "parent", agentRole: "worker" }, "parent", "turn");
  tracker.project(marker("completed", "done"), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual([]);
  let rechecks = 0;
  for (let i = 0; i < 150; i++) {
    const start = marker(); start.params.item.agentThreadId = `child-${i}`;
    tracker.project(start, "parent", "turn"); tracker.takeMetadataRequests();
    const done = marker("completed", "done"); done.params.item.agentThreadId = `child-${i}`;
    tracker.project(done, "parent", "turn"); rechecks += tracker.takeMetadataRequests().length;
  }
  expect(rechecks).toBe(128);
  tracker.reset();
  tracker.project(marker(), "parent", "turn"); tracker.takeMetadataRequests();
  tracker.project(marker("completed", "done"), "parent", "turn");
  expect(tracker.takeMetadataRequests()).toEqual(["child"]);
});
