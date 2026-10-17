import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CanonicalChatSafeErrorSchema, CanonicalChatAgentActivityPayloadSchema, CanonicalChatContentSchema, type CanonicalChatContent } from "@matrix-os/contracts";
import { createOwnerToolOutputProjection } from "../../packages/gateway/src/chat/owner-tool-output.js";

const key = Buffer.alloc(32, 7);
const owner = { type: "personal" as const, ownerId: "alice" };
const command = "cat /home/matrix/home/projects/demo/README.md\n" + "printf synthetic-line\n".repeat(70).trim();
function fixture(): CanonicalChatContent {
  const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12, 1));
  cipher.setAAD(Buffer.from("matrix-tool-preview:v1:command_test"));
  const data = Buffer.concat([cipher.update(command, "utf8"), cipher.final()]);
  return {
    record: { chat: { id: "chat_test", ownerScope: owner, title: "Test", lifecycle: "active", attention: "none", revision: 1,
      messageCount: 0, createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z" } },
    activities: [{ id: "evt_test", runId: "run_test", chatId: "chat_test", sequence: 1, occurredAt: "2026-09-20T00:00:00.000Z",
      type: "agent.activity", activityId: "command_test", kind: "command", label: "Run command", status: "completed",
      protectedPreview: { version: 1, iv: Buffer.alloc(12, 1).toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") },
    }],
  };
}

describe("private owner command previews", () => {
  it("opens a bounded path/multiline command after reload without mutating stored ciphertext", () => {
    const stored = JSON.parse(JSON.stringify(fixture()));
    const before = JSON.stringify(stored);
    const projected = createOwnerToolOutputProjection(key, ["alice"])(owner, stored);
    expect(projected.activities![0]).toMatchObject({ preview: command, previewKind: "command", status: "completed" });
    expect(JSON.stringify(projected)).not.toContain("protectedPreview");
    expect(CanonicalChatContentSchema.safeParse(projected).success).toBe(true);
    expect(JSON.stringify(stored)).toBe(before);
    expect(before).not.toContain("/home/matrix/home");
  });

  it.each(["wrong-owner", "unconfigured-owner", "shared", "no-key", "other-chat", "other-tool", "output-envelope"])("withholds command and strips ciphertext for %s", mode => {
    const value = fixture();
    if (mode === "shared") value.record.chat.collaboration = { mode: "shared", membership: { role: "owner", memberCount: 2 } };
    if (mode === "other-chat") value.activities![0]!.chatId = "chat_other";
    if (mode === "other-tool") { const activity = value.activities![0]!; if (activity.type === "agent.activity") activity.activityId = "command_other"; }
    if (mode === "output-envelope") {
      const activity = value.activities![0]!;
      if (activity.type !== "agent.activity") throw new Error("Invalid fixture");
      // Reusing a result envelope for a preview must fail purpose authentication.
      const cipher = createCipheriv("aes-256-gcm", key, Buffer.alloc(12, 2));
      cipher.setAAD(Buffer.from("matrix-tool-output:v1:command_test"));
      const data = Buffer.concat([cipher.update(command), cipher.final()]);
      activity.protectedPreview = { version: 1, iv: Buffer.alloc(12, 2).toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
    }
    const projected = createOwnerToolOutputProjection(mode === "no-key" ? undefined : key, mode === "unconfigured-owner" ? [] : ["alice"])(
      mode === "wrong-owner" ? { type: "personal", ownerId: "bob" } : owner, value);
    expect(JSON.stringify(projected)).not.toContain("/home/matrix/home");
    expect(JSON.stringify(projected)).not.toContain("protectedPreview");
  });

  it("allows owner command paths while keeping unsafe labels and errors out of their original contracts", () => {
    const base = { activityId: "command_test", kind: "command", label: "Run command", status: "completed", previewKind: "command" };
    expect(CanonicalChatAgentActivityPayloadSchema.safeParse({ ...base, preview: command }).success).toBe(true);
    expect(CanonicalChatAgentActivityPayloadSchema.safeParse({ ...base, label: "/home/matrix/home/private", preview: command }).success).toBe(false);
    expect(CanonicalChatAgentActivityPayloadSchema.safeParse({ ...base, preview: "TOKEN=qa-secret" }).success).toBe(false);
    expect(CanonicalChatAgentActivityPayloadSchema.safeParse({ ...base, preview: "echo \u0000" }).success).toBe(false);
    expect(CanonicalChatSafeErrorSchema.safeParse({ code: "run_failed", safeMessage: "/home/matrix/home/private/error", retryable: true, recoveryActions: ["retry"] }).success).toBe(false);
  });
});
