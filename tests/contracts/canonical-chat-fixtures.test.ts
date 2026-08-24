import { describe, expect, it } from "vitest";
import {
  CanonicalChatSnapshotSchema,
  CanonicalChatInspectorProjectionSchema,
  CanonicalChatMessagePartSchema,
  CanonicalChatRunActivitySchema,
  CanonicalProviderCatalogSchema,
} from "../../packages/contracts/src/index.js";
import {
  CANONICAL_CHAT_FIXTURE_STATES,
  CANONICAL_INSPECTOR_FIXTURE_STATES,
  CANONICAL_PROVIDER_FIXTURE_AVAILABILITIES,
  createCanonicalChatFixture,
  createCanonicalInspectorFixture,
  createCanonicalMessagePartsFixture,
  createCanonicalProviderCatalogFixture,
  createCanonicalRunActivitiesFixture,
} from "./fixtures/canonical-chat.js";

describe("canonical Chat fixtures", () => {
  it("round-trips every supported presentation state through public schemas", () => {
    for (const state of CANONICAL_CHAT_FIXTURE_STATES) {
      const fixture = createCanonicalChatFixture(state);
      const snapshot = CanonicalChatSnapshotSchema.parse(
        JSON.parse(JSON.stringify(fixture.snapshot)),
      );
      const catalog = CanonicalProviderCatalogSchema.parse(
        JSON.parse(JSON.stringify(fixture.providerCatalog)),
      );

      expect(snapshot.chat.id).toBe(`chat_fixture_${state}`);
      expect(catalog.instances[0]?.id).toBe("codex_fixture");
      if (state === "approval_required" || state === "input_required" || state === "failed") {
        expect(snapshot.chat.attention).toBe(state);
      }
    }
  });

  it("covers every Provider readiness and inspector-change presentation state", () => {
    for (const availability of CANONICAL_PROVIDER_FIXTURE_AVAILABILITIES) {
      const catalog = CanonicalProviderCatalogSchema.parse(
        createCanonicalProviderCatalogFixture(availability),
      );
      expect(catalog.instances[0]?.availability).toBe(availability);
    }
    for (const state of CANONICAL_INSPECTOR_FIXTURE_STATES) {
      const inspector = CanonicalChatInspectorProjectionSchema.parse(
        JSON.parse(JSON.stringify(createCanonicalInspectorFixture(state))),
      );
      expect(inspector.changes.availability).toBe(state === "unavailable" ? "unavailable" : "available");
      if (inspector.changes.availability === "available") {
        expect(inspector.changes.partial).toBe(state === "partial");
      }
    }
  });

  it("covers every canonical message part used by the shared timeline", () => {
    const parts = createCanonicalMessagePartsFixture().map((part) => (
      CanonicalChatMessagePartSchema.parse(JSON.parse(JSON.stringify(part)))
    ));
    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "tool_request",
      "tool_result",
      "attachment_reference",
      "approval_request",
      "approval_result",
      "status",
      "summary",
      "invocation_reference",
      "resource_reference",
    ]);
  });

  it("covers every normalized Run activity used by shared shells", () => {
    const activities = createCanonicalRunActivitiesFixture().map((activity) => (
      CanonicalChatRunActivitySchema.parse(JSON.parse(JSON.stringify(activity)))
    ));
    expect(activities.map((activity) => activity.type)).toEqual([
      "run.status",
      "turn.status",
      "assistant.delta",
      "tool.output",
      "tool.progress",
      "review.ready",
      "terminal.bound",
      "run.error",
      "approval.requested",
      "approval.resolved",
      "input.requested",
      "input.resolved",
      "resource.changed",
      "message.committed",
    ]);
  });

  it("returns fresh fixture values so parallel UI tests cannot mutate one another", () => {
    const first = createCanonicalChatFixture("running");
    const second = createCanonicalChatFixture("running");

    first.snapshot.messages[0]!.parts[0] = { type: "text", text: "mutated" };
    expect(second.snapshot.messages[0]!.parts[0]).toEqual({
      type: "text",
      text: "Build the canonical Chat contract.",
    });
  });

  it("rejects dangling and contradictory Snapshot references", () => {
    const fixture = createCanonicalChatFixture("running");
    const secondInput = {
      ...fixture.snapshot.messages[0]!,
      id: "msg_second_input",
      seq: 2,
      turnId: "cturn_second",
    };
    const secondTurn = {
      ...fixture.snapshot.turns[0]!,
      id: "cturn_second",
      clientRequestId: "req_second",
      inputMessageId: secondInput.id,
    };
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      activities: fixture.snapshot.activities.map((activity) => ({ ...activity, runId: "run_missing" })),
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      runs: [],
      activities: [],
      chat: { ...fixture.snapshot.chat, activeRun: undefined },
      inspector: { ...fixture.snapshot.inspector, run: undefined },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      messages: fixture.snapshot.messages.map((message) => ({
        ...message,
        role: "assistant" as const,
        turnId: undefined,
      })),
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      chat: {
        ...fixture.snapshot.chat,
        activeRun: { ...fixture.snapshot.chat.activeRun!, status: "waiting_for_input" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        run: { ...fixture.snapshot.inspector.run!, instanceId: "codex_other" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        run: { ...fixture.snapshot.inspector.run!, driverKind: "claude_code" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        run: { ...fixture.snapshot.inspector.run!, model: "other-model" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      runs: fixture.snapshot.runs.map((run) => ({ ...run, turnId: "cturn_missing" })),
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      messages: [...fixture.snapshot.messages, { ...fixture.snapshot.messages[0]!, seq: 2 }],
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      turns: [...fixture.snapshot.turns, { ...fixture.snapshot.turns[0]!, clientRequestId: "req_duplicate_turn" }],
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      activities: [...fixture.snapshot.activities, { ...fixture.snapshot.activities[0]! }],
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      messages: [
        ...fixture.snapshot.messages,
        secondInput,
        { ...secondInput, id: "msg_cross_turn", seq: 3, role: "assistant", runId: fixture.snapshot.runs[0]!.id },
      ],
      turns: [...fixture.snapshot.turns, secondTurn],
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      messages: [...fixture.snapshot.messages, secondInput],
      turns: [...fixture.snapshot.turns, secondTurn],
      activities: fixture.snapshot.activities.map((activity) => ({
        ...activity,
        type: "turn.status" as const,
        turnId: secondTurn.id,
        status: "running" as const,
      })),
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      runs: [
        ...fixture.snapshot.runs,
        { ...fixture.snapshot.runs[0]!, id: "run_second_active", attempt: 2 },
      ],
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      chat: { ...fixture.snapshot.chat, activeRun: undefined },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        run: { ...fixture.snapshot.inspector.run!, runId: "run_missing" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        run: { ...fixture.snapshot.inspector.run!, status: "waiting_for_input" },
      },
    }).success).toBe(false);
    expect(CanonicalChatSnapshotSchema.safeParse({
      ...fixture.snapshot,
      inspector: {
        ...fixture.snapshot.inspector,
        changes: {
          availability: "available",
          turnId: "cturn_missing",
          changedFileCount: 0,
          additions: 0,
          deletions: 0,
          partial: false,
          files: [],
        },
      },
    }).success).toBe(false);
  });
});
