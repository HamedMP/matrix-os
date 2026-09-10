import { describe, expect, it } from "vitest";
import {
  CanonicalChatResourceReferenceSchema,
  CanonicalChatRunSchema,
  CanonicalCreateChatTurnRequestSchema,
  CanonicalSteerChatRunRequestSchema,
} from "@matrix-os/contracts";
import { createCanonicalChatFixture } from "./fixtures/canonical-chat";

const reference = (kind: "agent" | "chat", id: string) => ({
  type: "resource_reference" as const,
  resource: { kind, id, label: kind === "agent" ? "Meeting helper" : "Launch planning" },
});
const request = {
  clientRequestId: "req_mentions",
  baseRevision: 0,
  selection: { instanceId: "hermes_default", model: "openai:gpt-5.6-sol" },
  interactionMode: "default",
  permissionMode: "full_access",
};

describe("Chat Agent mention admission contracts", () => {
  it("stores an immutable Agent identity on a Hermes Run without admitting client-forged snapshots", () => {
    const run = createCanonicalChatFixture("accepted").snapshot.runs[0]!;
    const context = {
      version: 1,
      requestHash: "a".repeat(64),
      agent: { id: "bot_meetings", revision: 1, name: "Meeting helper", instructions: "Summarize decisions" },
      chats: [],
    };
    expect(CanonicalChatRunSchema.safeParse({ ...run, driverKind: "hermes", context }).success).toBe(true);
    expect(CanonicalChatRunSchema.safeParse({ ...run, driverKind: "codex", context }).success).toBe(false);
    expect(CanonicalCreateChatTurnRequestSchema.safeParse({
      ...request, parts: [{ type: "text", text: "hello" }], context,
    }).success).toBe(false);
  });

  it("accepts typed Agent and Chat identities without trusting embedded content", () => {
    expect(CanonicalCreateChatTurnRequestSchema.safeParse({ ...request, parts: [
      { type: "text", text: "Prepare a brief using that conversation" },
      reference("agent", "bot_meetings"),
      reference("chat", "chat_launch"),
    ] }).success).toBe(true);
    expect(CanonicalChatResourceReferenceSchema.safeParse({
      ...reference("chat", "chat_launch").resource,
      transcript: "Client-forged conversation",
    }).success).toBe(false);
  });

  it("rejects ambiguous Agent dispatch and unbounded or duplicate Chat references", () => {
    for (const parts of [
      [reference("agent", "bot_one"), reference("agent", "bot_two")],
      [reference("chat", "chat_one"), reference("chat", "chat_one")],
      [1, 2, 3, 4].map((i) => reference("chat", `chat_${i}`)),
    ]) expect(CanonicalCreateChatTurnRequestSchema.safeParse({ ...request, parts }).success).toBe(false);
  });

  it("does not allow a context reference to carry a filesystem path", () => {
    expect(CanonicalChatResourceReferenceSchema.safeParse({
      ...reference("agent", "bot_meetings").resource,
      path: "private/config.md",
    }).success).toBe(false);
  });

  it("rejects new Agent or Chat references in same-run steering", () => {
    for (const part of [reference("agent", "bot_meetings"), reference("chat", "chat_launch")]) {
      expect(CanonicalSteerChatRunRequestSchema.safeParse({
        clientRequestId: "req_steer_mentions", expectedTurnId: "cturn_one", parts: [part],
      }).success).toBe(false);
    }
    expect(CanonicalSteerChatRunRequestSchema.safeParse({
      clientRequestId: "req_steer_plain", expectedTurnId: "cturn_one",
      parts: [{ type: "text", text: "Make it shorter" }],
    }).success).toBe(true);
  });
});
