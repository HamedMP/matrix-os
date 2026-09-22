import { expect, it } from "vitest";
import { createHermesSubagentActivity } from "../../packages/gateway/src/chat/hermes-subagent-activity.js";

it("keeps concurrent children distinct through reverse completion and duplicate start", () => {
  const project = createHermesSubagentActivity("parent");
  const first = project("subagent.spawn_requested", { subagent_id: "a", task_index: 0, goal: "Compute 19 times 23" })!;
  const second = project("subagent.start", { subagent_id: "b", task_index: 1, goal: "Compute sum" })!;
  expect(first.activityId).not.toBe(second.activityId);
  expect(project("subagent.start", { subagent_id: "a", task_index: 0 })?.activityId).toBe(first.activityId);
  expect(project("subagent.complete", { subagent_id: "b", status: "completed", summary: "5050" })?.subagent).toMatchObject({ status: "completed", result: "5050", task: "Compute sum" });
  expect(project("subagent.complete", { subagent_id: "a", status: "completed", summary: "437" })?.subagent).toMatchObject({ status: "completed", result: "437" });
});
it("does not guess identity or role and withholds private child text", () => {
  const project = createHermesSubagentActivity("parent");
  project("subagent.start", { subagent_id: "a", task_index: 0, goal: "read /home/private/file" });
  project("subagent.start", { subagent_id: "b", task_index: 1 });
  expect(project("subagent.complete", { status: "completed", summary: "ambiguous" })).toBeUndefined();
  const result = project("subagent.complete", { subagent_id: "a", status: "completed", summary: "the password is secret" });
  expect(result?.subagent).toMatchObject({ name: "Subagent 1", status: "completed" });
  expect(result?.subagent?.role).toBeUndefined();
  expect(result?.subagent?.task).toBeUndefined();
  expect(result?.subagent?.result).toBeUndefined();
  expect(project("subagent.complete", { subagent_id: "unknown", status: "completed" })).toBeUndefined();
});
it("bounds children and retains observed completion despite a late start", () => {
  const project = createHermesSubagentActivity("parent");
  for (let i = 0; i < 129; i++) project("subagent.start", { subagent_id: String(i), task_index: i });
  expect(project("subagent.complete", { subagent_id: "0", status: "completed" })).toBeUndefined();
  project("subagent.complete", { subagent_id: "128", status: "completed", summary: "done" });
  expect(project("subagent.start", { subagent_id: "128", task_index: 128 })?.subagent?.status).toBe("completed");
});
it("retains indexed legacy children without assigning an ambiguous completion", () => {
  const project = createHermesSubagentActivity("parent");
  expect(project("subagent.start", { task_index: 0 })?.subagent?.status).toBe("running");
  expect(project("subagent.start", { task_index: 1 })?.subagent?.status).toBe("running");
  expect(project("subagent.complete", { status: "completed" })).toBeUndefined();
  expect(project("subagent.complete", { task_index: 0, status: "completed", summary: "437" })?.subagent?.result).toBe("437");
});
