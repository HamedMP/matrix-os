import { describe, expect, it } from "vitest";
import { CanonicalChatAgentActivityPayloadSchema, type CanonicalChatRunActivity, type AgentThreadEvent } from "@matrix-os/contracts";
import { CanonicalProviderRunEventSchema } from "../../packages/gateway/src/chat/provider-adapter.js";
import { stripProtectedCommandPreviews, createOwnerToolOutputProjection } from "../../packages/gateway/src/chat/owner-tool-output.js";
import { projectThreadEventForClient } from "../../packages/gateway/src/coding-agents/thread-client-projection.js";
import { sealToolPreview } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";

const command = "cat /home/matrix/home/projects/demo/README.md\n" + "printf synthetic-line\n".repeat(70).trim();
const activity = { activityId: "command_test", kind: "command" as const, label: "Run command", status: "completed" as const };

describe("coarse plaintext provider activity ingress", () => {
  it.each(["inspect .ssh/config", "ls /opt/matrix/app", "cat /home/matrix/home/private/report.txt", "echo API_KEY=qa-fake", "x".repeat(1001)])(
    "rejects unsafe or oversized unprotected provider preview: %s", preview => {
      expect(CanonicalProviderRunEventSchema.safeParse({ type: "agent.activity", ...activity, preview, previewKind: "command" }).success).toBe(false);
    });

  it("keeps encrypted 4K owner command evidence separate from the strict 1K plaintext ingress", () => {
    const protectedPreview = sealToolPreview(Buffer.alloc(32, 1), "command_test", command);
    expect(CanonicalProviderRunEventSchema.safeParse({ type: "agent.activity", ...activity, protectedPreview }).success).toBe(true);
    expect(CanonicalProviderRunEventSchema.safeParse({ type: "agent.activity", ...activity, preview: "printf ok", previewKind: "command", protectedPreview }).success).toBe(true);
    expect(CanonicalChatAgentActivityPayloadSchema.safeParse({ ...activity, preview: command, previewKind: "command" }).success).toBe(true);
  });
});

it.each(["inspect .ssh/config", "ls /opt/matrix/app", "echo API_KEY=qa-fake", "x".repeat(1001)])(
  "strips unsafe unprotected historical preview from exports and legacy thread copies: %s", preview => {
    const stored: Extract<CanonicalChatRunActivity, { type: "agent.activity" }> = {
      ...activity, type: "agent.activity", id: "evt_test", chatId: "chat_test", runId: "run_test", occurredAt: "2026-10-12T00:00:00.000Z",
      preview, previewKind: "command",
    };
    const before = JSON.stringify(stored);
    const exported = stripProtectedCommandPreviews([stored]);
    expect(exported[0]).not.toHaveProperty("preview");
    expect(exported[0]).not.toHaveProperty("previewKind");
    const threadEvent: Extract<AgentThreadEvent, { type: "tool.started" }> = {
      type: "tool.started", eventId: "evt_test", threadId: "thread_test", occurredAt: stored.occurredAt,
      toolCallId: "command_test", displayName: "Run command", kind: "command", preview, previewKind: "command",
    };
    const external = projectThreadEventForClient(threadEvent);
    expect(external).not.toHaveProperty("preview");
    expect(external).not.toHaveProperty("previewKind");
    expect(JSON.stringify(stored)).toBe(before);
  });

it.each(["inspect .ssh/config", "psql postgresql://example.invalid/database", "ls /opt/matrix/app", "echo API_KEY=qa-fake"])(
  "withholds historical unsafe plaintext for shared, foreign and no-key owner projections: %s", preview => {
    const owner = { type: "personal" as const, ownerId: "alice" };
    const stored = { record: { chat: { id: "chat_test", ownerScope: owner, title: "Test", lifecycle: "active" as const,
      attention: "none" as const, revision: 1, messageCount: 0, createdAt: "2026-10-12T00:00:00.000Z", updatedAt: "2026-10-12T00:00:00.000Z" } },
      activities: [{ ...activity, id: "evt_test", chatId: "chat_test", runId: "run_test", occurredAt: "2026-10-12T00:00:00.000Z",
        type: "agent.activity" as const, preview, previewKind: "command" as const }] };
    const before = JSON.stringify(stored);
    const project = createOwnerToolOutputProjection(undefined, ["alice"]);
    for (const requestOwner of [owner, { type: "personal" as const, ownerId: "bob" }]) {
      const response = project(requestOwner, stored);
      expect(response.activities[0]).not.toHaveProperty("preview");
      expect(response.activities[0]).not.toHaveProperty("previewKind");
    }
    const shared = { ...stored, record: { chat: { ...stored.record.chat,
      collaboration: { mode: "shared" as const, membership: { role: "owner" as const, memberCount: 2 } } } } };
    expect(project(owner, shared).activities[0]).not.toHaveProperty("preview");
    expect(JSON.stringify(stored)).toBe(before);
  });
