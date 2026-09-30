import { expect, it } from "vitest";
import { projectAoedeCanonical, safeAoedeArtifactPath } from "../../packages/ui/src/aoede/projection.js";
import type { CanonicalChatDetailResponse } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";
it("uses only canonical safeDescription, de-duplicates approval IDs and hides secret previews", () => {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const runId = fixture.runs[0].id;
  const activity = { id: "activity_approval", chatId: fixture.chat.id, runId, occurredAt: fixture.chat.createdAt, type: "approval.requested" as const, approvalId: "approval_1", title: "Create timer", safeDescription: "password=super-secret", risk: "low" as const, allowedDecisions: ["approve" as const], argumentDigest: "a".repeat(64) };
  const detail = { record: { chat: fixture.chat }, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs, activities: [activity, { ...activity, id: "activity_latest", argumentDigest: "b".repeat(64) }] };
  const projection = projectAoedeCanonical(detail);
  expect(projection.approvals).toHaveLength(1); expect(projection.approvals[0].description).toBe("Details withheld for privacy."); expect(projection.approvals[0].argumentDigest).toBe("b".repeat(64));
});
it("projects canonical terminal outcome and real tool state, not elapsed-time percentages", () => {
  const fixture = createCanonicalChatFixture("failed").snapshot;
  const projection = projectAoedeCanonical({ record: { chat: fixture.chat }, messages: fixture.messages, turns: fixture.turns, runs: fixture.runs, activities: [{ id: "activity_tool", chatId: fixture.chat.id, runId: fixture.runs[0].id, occurredAt: fixture.chat.createdAt, type: "tool.progress", toolCallId: "tool_1", label: "Create app", status: "failed" }] });
  expect(projection.outcome).toBe("failed"); expect(projection.canCancel).toBe(false); expect(projection.progress[0]).toEqual({ id: "tool_1", kind: "tool", label: "Create app", state: "failed" });
});

it("only projects the current bounded captions, never guesses progress", () => {
  const detail = { record: { chat: { id: "chat_test" } }, messages: [
    { id: "msg_old", seq: 1, role: "user", parts: [{ type: "text", text: "old history" }] },
    { id: "msg_current", seq: 2, role: "user", parts: [{ type: "text", text: "x".repeat(2000) }] },
    { id: "msg_response", seq: 3, role: "assistant", parts: [{ type: "text", text: "latest response" }] },
  ], turns: [], runs: [], activities: [] } as unknown as CanonicalChatDetailResponse;
  const projection = projectAoedeCanonical(detail);
  expect(projection.captions.utterance?.length).toBeLessThanOrEqual(600); expect(projection.captions.response).toBe("latest response"); expect(projection.progress).toEqual([]);
});
it("rejects URLs, traversal, encoded paths, credentials and hidden configuration for result navigation", () => {
  for (const path of ["https://secret.test/x", "../secret", "apps/%2e%2e/key", "/etc/passwd", ".env", "system/config.json", "apps/a\\secret", "apps/a?token=x", "apps/a/credentials.json", "apps/a/id_rsa", "apps/a/key.pem"]) expect(safeAoedeArtifactPath(path)).toBeNull();
  expect(safeAoedeArtifactPath("apps/timer/src/main.ts")).toBe("apps/timer/src/main.ts");
});
