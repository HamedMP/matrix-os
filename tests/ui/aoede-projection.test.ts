import { expect, it } from "vitest";
import { projectAoedeCanonical, safeAoedeArtifactPath } from "../../packages/ui/src/aoede/projection.js";
import type { CanonicalChatDetailResponse, CanonicalOperationView } from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

function operationView(overrides: Partial<CanonicalOperationView> = {}): CanonicalOperationView {
  return {
    id: "action_ui_1",
    chatId: "chat_ui",
    runId: "run_ui",
    toolId: "matrix_open_app",
    schemaRevision: "canonical_apps_v1",
    policyRevision: "canonical_apps_v1_policy",
    state: "succeeded",
    argumentDigest: "a".repeat(64),
    cancellationRequested: false,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:01:00.000Z",
    ...overrides,
  };
}
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

it("projects operations newest-first across all runs with navigation from the newest carrier", () => {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const older = operationView({
    id: "action_ui_old", state: "succeeded", updatedAt: "2026-09-30T00:02:00.000Z",
    result: { navigation: { kind: "open_app", app: "timer", path: "apps/timer" } },
  });
  const newest = operationView({
    id: "action_ui_new", state: "running", updatedAt: "2026-09-30T00:03:00.000Z",
    result: { navigation: { kind: "open_app", app: "clock", path: "apps/clock" } },
  });
  const detail = {
    record: { chat: fixture.chat }, messages: [], turns: [], runs: fixture.runs, activities: [],
    operations: [older, newest],
  } as unknown as CanonicalChatDetailResponse;
  const projection = projectAoedeCanonical(detail);
  expect(projection.operations.map(operation => operation.id)).toEqual(["action_ui_new", "action_ui_old"]);
  expect(projection.navigation).toEqual({ app: "clock", path: "apps/clock", operationId: "action_ui_new" });
  expect(projection.outcomeUnknown).toEqual([]);
});

it("only lists before-dispatch operations as cancellable", () => {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const detail = {
    record: { chat: fixture.chat }, messages: [], turns: [], runs: fixture.runs, activities: [],
    operations: [
      operationView({ id: "action_ui_proposed", state: "proposed" }),
      operationView({ id: "action_ui_waiting", state: "waiting_for_approval" }),
      operationView({ id: "action_ui_running", state: "running" }),
      operationView({ id: "action_ui_requested", state: "running", cancellationRequested: true }),
      operationView({ id: "action_ui_done", state: "succeeded" }),
      operationView({ id: "action_ui_unknown", state: "outcome_unknown" }),
    ],
  } as unknown as CanonicalChatDetailResponse;
  const projection = projectAoedeCanonical(detail);
  expect(projection.cancellableActionIds.sort()).toEqual([
    "action_ui_proposed", "action_ui_waiting",
  ]);
  expect(projection.outcomeUnknown.map(operation => operation.id)).toEqual(["action_ui_unknown"]);
});

it("collects artifact and file paths into deduped bounded actionArtifacts", () => {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const detail = {
    record: { chat: fixture.chat }, messages: [], turns: [], runs: fixture.runs, activities: [],
    operations: [
      operationView({
        id: "action_ui_files", state: "succeeded",
        result: {
          artifact: { kind: "app", path: "apps/timer" },
          files: [
            { path: "apps/timer/src/main.ts", sha256: "a".repeat(64) },
            { path: "apps/timer/src/main.ts", sha256: "a".repeat(64) },
            { path: "apps/timer/.env", truncated: false },
          ],
        },
      }),
      operationView({
        id: "action_ui_more", state: "succeeded",
        result: { files: [{ path: "apps/clock/index.ts" }] },
      }),
    ],
  } as unknown as CanonicalChatDetailResponse;
  const projection = projectAoedeCanonical(detail);
  expect(projection.actionArtifacts).toEqual([
    "apps/timer", "apps/timer/src/main.ts", "apps/clock/index.ts",
  ]);
  // Unsafe segments (hidden config/credentials) are filtered by the same gate as message artifacts.
  expect(projection.actionArtifacts).not.toContain("apps/timer/.env");
});

it("caps operations at 32 and still surfaces them without a run", () => {
  const fixture = createCanonicalChatFixture("running").snapshot;
  const operations = Array.from({ length: 40 }, (_, index) => operationView({
    id: `action_ui_${String(index).padStart(2, "0")}`,
    updatedAt: `2026-09-30T00:${String(index % 60).padStart(2, "0")}:00.000Z`,
  }));
  const detail = {
    record: { chat: fixture.chat }, messages: [], turns: [], runs: fixture.runs, activities: [],
    operations,
  } as unknown as CanonicalChatDetailResponse;
  const projection = projectAoedeCanonical(detail);
  expect(projection.operations).toHaveLength(32);
  expect(projection.operations[0]?.id).toBe("action_ui_39");

  const empty = projectAoedeCanonical(null);
  expect(empty.operations).toEqual([]);
  expect(empty.navigation).toBeUndefined();
  expect(empty.cancellableActionIds).toEqual([]);
  expect(empty.actionArtifacts).toEqual([]);
});
