import { expect, it } from "vitest";
import { canonicalChatToolActivities } from "@matrix-os/contracts";
import { canonicalChatPresentation } from "@desktop/renderer/src/features/chat/canonical-chat-presentation";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

it.each(["accepted", "completed"] as const)("preserves child identity, ordering and observed status on %s replay", (status) => {
  const { snapshot } = createCanonicalChatFixture(status);
  const run = snapshot.runs[0]!;
  const child = { agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "running" as const };
  const activities = [1, 2, 2].map((sequence) => ({
    id: `activity_${sequence}`, chatId: snapshot.chat.id, runId: run.id, sequence,
    type: "agent.activity" as const, activityId: "child_activity", kind: "delegation" as const,
    label: "Research", status: "running" as const, subagent: child, occurredAt: run.createdAt,
  }));
  const shared = canonicalChatToolActivities(run, activities);
  expect(shared).toHaveLength(1);
  expect(shared[0]?.subagent).toMatchObject({ agentId: "agent_child", status: status === "accepted" ? "running" : "unknown" });
  const desktop = canonicalChatPresentation({ ...snapshot, activities });
  const rows = desktop.flatMap((turn) => turn.work.flatMap((entry) => entry.kind === "activity-group" ? entry.activities : []));
  expect(rows.filter((row) => row.subagent)).toHaveLength(1);
  expect(rows.find((row) => row.subagent)?.subagent).toEqual(shared[0]?.subagent);
});

it("keeps the same child row and group identity as new activity events stream", () => {
  const { snapshot } = createCanonicalChatFixture("accepted");
  const run = snapshot.runs[0]!;
  const activity = { id: "evt_started", chatId: snapshot.chat.id, runId: run.id, sequence: 1,
    type: "agent.activity" as const, activityId: "child_activity", kind: "delegation" as const,
    label: "Research", status: "running" as const, occurredAt: run.createdAt,
    subagent: { agentId: "agent_child", parentAgentId: "agent_parent", name: "Research", status: "running" as const },
  };
  const group = (activities: typeof activity[]) => canonicalChatPresentation({ ...snapshot, activities })
    .flatMap((turn) => turn.work).find((entry) => entry.kind === "activity-group" && entry.activities.some((row) => row.subagent));
  const before = group([activity]);
  const after = group([activity, { ...activity, id: "evt_progress", sequence: 2 }]);
  expect(after?.id).toBe(before?.id);
  if (before?.kind === "activity-group" && after?.kind === "activity-group") expect(after.activities[0]?.id).toBe(before.activities[0]?.id);
});
