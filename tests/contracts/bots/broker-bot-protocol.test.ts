import { describe, expect, it } from "vitest";
import {
  BotEventSchema,
  BotSessionSaveRequestSchema,
  BotToolErrorCodeSchema,
  BotToolRequestSchema,
  BotToolResultSchema,
} from "@matrix-os/contracts";

describe("bot broker tool contracts", () => {
  it("validates each M1 capability with its own argument schema", () => {
    expect(BotToolRequestSchema.parse({ toolCallId: "call_1", capability: "integration.inventory", args: {} }).capability)
      .toBe("integration.inventory");
    expect(BotToolRequestSchema.parse({
      toolCallId: "call_2",
      capability: "integration.call",
      args: { service: "gmail", action: "gmail.list_messages", connectionId: "conn_1", params: { query: "from:acme" } },
    }).capability).toBe("integration.call");
    expect(BotToolRequestSchema.parse({
      toolCallId: "call_3",
      capability: "memory.propose",
      args: { kind: "fact", scope: "bot", content: "Acme launched a new tier", source: { url: "https://acme.example/pricing", at: "2026-09-27T12:00:00.000Z" } },
    }).capability).toBe("memory.propose");
    expect(BotToolRequestSchema.parse({ toolCallId: "call_4", capability: "memory.search", args: { query: "pricing", limit: 5 } }).capability)
      .toBe("memory.search");
    expect(BotToolRequestSchema.parse({
      toolCallId: "call_5",
      capability: "interaction.create",
      args: { blocking: true, payload: { kind: "question", questions: [{ questionId: "q1", header: "Company", question: "Which one?" }] } },
    }).capability).toBe("interaction.create");
    expect(BotToolRequestSchema.parse({
      toolCallId: "call_6",
      capability: "artifact.write",
      args: { relPath: "briefs/acme.md", content: "# Acme", mimeType: "text/markdown" },
    }).capability).toBe("artifact.write");
    expect(BotToolRequestSchema.parse({ toolCallId: "call_7", capability: "artifact.read", args: { relPath: "briefs/acme.md" } }).capability)
      .toBe("artifact.read");
  });

  it("rejects arguments for the wrong capability, traversal, and oversized payloads", () => {
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_1", capability: "memory.search", args: { relPath: "x" } }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_1", capability: "artifact.read", args: { relPath: "../secret" } }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_1", capability: "artifact.read", args: { relPath: "/etc/passwd" } }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({
      toolCallId: "call_1",
      capability: "artifact.write",
      args: { relPath: "big.md", content: "x".repeat(192 * 1024 + 1), mimeType: "text/markdown" },
    }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({
      toolCallId: "call_1",
      capability: "artifact.write",
      args: { relPath: "run.sh", content: "echo", mimeType: "application/x-sh" },
    }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({
      toolCallId: "call_1",
      capability: "integration.call",
      args: { service: "gmail", action: "gmail.list_messages", connectionId: "conn_1", params: { blob: "x".repeat(33 * 1024) } },
    }).success).toBe(false);
    expect(BotToolRequestSchema.safeParse({ toolCallId: "call_1", capability: "shell.exec", args: {} }).success).toBe(false);
    // 192 KiB of backslashes doubles when JSON-escaped and must not pass the serialized cap.
    expect(BotToolRequestSchema.safeParse({
      toolCallId: "call_1",
      capability: "artifact.write",
      args: { relPath: "escaped.md", content: "\\".repeat(192 * 1024), mimeType: "text/markdown" },
    }).success).toBe(false);
  });

  it("returns text content or an allowlisted error code only", () => {
    expect(BotToolResultSchema.parse({ ok: true, content: [{ type: "text", text: "3 messages" }] }).ok).toBe(true);
    expect(BotToolResultSchema.parse({ ok: false, code: "not_granted" }).ok).toBe(false);
    expect(BotToolResultSchema.safeParse({ ok: false, code: "not_granted", message: "postgres said no" }).success).toBe(false);
    expect(BotToolErrorCodeSchema.options).toEqual([
      "denied", "not_granted", "approval_required", "invalid_arguments", "unavailable", "timeout", "budget_exhausted", "stale_generation",
    ]);
  });
});

describe("bot event and session contracts", () => {
  it("projects ordered, bounded events", () => {
    expect(BotEventSchema.parse({ seq: 0, event: { type: "assistant_delta", text: "Looking at Acme" } }).seq).toBe(0);
    expect(BotEventSchema.parse({ seq: 1, event: { type: "tool_progress", toolCallId: "call_1", capability: "integration.call", phase: "started" } }).seq).toBe(1);
    expect(BotEventSchema.safeParse({ seq: -1, event: { type: "assistant_delta", text: "x" } }).success).toBe(false);
    expect(BotEventSchema.safeParse({ seq: 2, event: { type: "assistant_delta", text: "x".repeat(16 * 1024 + 1) } }).success).toBe(false);
    expect(BotEventSchema.safeParse({ seq: 2, event: { type: "thinking_delta", text: "hidden" } }).success).toBe(false);
  });

  it("caps saved sessions at 512 KiB and requires a base revision", () => {
    expect(BotSessionSaveRequestSchema.parse({ baseRevision: 0, messages: [{ role: "user", content: "hi" }] }).baseRevision).toBe(0);
    expect(BotSessionSaveRequestSchema.safeParse({ messages: [] }).success).toBe(false);
    expect(BotSessionSaveRequestSchema.safeParse({ baseRevision: 0, messages: [{ role: "user", content: "x".repeat(512 * 1024) }] }).success)
      .toBe(false);
  });
});
