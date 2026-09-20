import { describe, expect, it } from "vitest";
import { createOwnerToolOutputProjection } from "../../packages/gateway/src/chat/owner-tool-output.js";
import { sealToolOutput } from "../../packages/gateway/src/coding-agents/protected-tool-output.mjs";
import type { CanonicalChatContent } from "@matrix-os/contracts";
const key = Buffer.alloc(32, 7);
const owner = { type: "personal" as const, ownerId: "alice" };
function content(): CanonicalChatContent {
  return { record: { chat: {
    id: "chat_test", ownerScope: owner, title: "Test", lifecycle: "active", attention: "none", revision: 1, messageCount: 0,
    createdAt: "2026-09-20T00:00:00.000Z", updatedAt: "2026-09-20T00:00:00.000Z",
  } }, activities: [{ id: "evt_test", runId: "run_test", chatId: "chat_test", sequence: 1,
    occurredAt: "2026-09-20T00:00:00.000Z", type: "tool.output", toolCallId: "tool_test",
    text: "Tool output is private to its owner.", truncated: false,
    protectedOutput: sealToolOutput(key, "tool_test", "OPAQUE_PRIVATE_RESULT"),
  }] };
}
describe("owner-only output response projection", () => {
  it("decrypts for the runtime owner without mutating persisted events", () => {
    const stored = content(); const before = JSON.stringify(stored);
    const response = createOwnerToolOutputProjection(key, ["alice"])(owner, stored);
    expect(JSON.stringify(response)).toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(response)).not.toContain("protectedOutput");
    expect(JSON.stringify(stored)).toBe(before);
    expect(before).not.toContain("OPAQUE_PRIVATE_RESULT");
  });
  it("keeps wrong-owner, shared and unconfigured-owner results coarse", () => {
    const project = createOwnerToolOutputProjection(key, ["alice"]);
    const cases = [content(), content()];
    cases[0].record.chat.ownerScope = { type: "personal", ownerId: "bob" };
    cases[1].record.chat.collaboration = { mode: "shared", membership: { role: "owner", memberCount: 2 } };
    for (const value of cases) expect(JSON.stringify(project(owner, value))).not.toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(project({ type: "personal", ownerId: "bob" }, content()))).not.toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(createOwnerToolOutputProjection(key, [])(owner, content()))).not.toContain("OPAQUE_PRIVATE_RESULT");
  });
  it("fails closed for a tampered envelope and a different Chat activity", () => {
    const project = createOwnerToolOutputProjection(key, ["alice"]);
    const value = content(); value.activities![0].chatId = "chat_other";
    expect(JSON.stringify(project(owner, value))).not.toContain("OPAQUE_PRIVATE_RESULT");
    const wrongKey = createOwnerToolOutputProjection(Buffer.alloc(32, 8), ["alice"]);
    expect(JSON.stringify(wrongKey(owner, content()))).not.toContain("OPAQUE_PRIVATE_RESULT");
  });
});

import { createCanonicalChatService } from "../../packages/gateway/src/chat/service.js";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import type { ChatOutboxEvent } from "../../packages/gateway/src/chat/records.js";
import type { ChatOutboxSink } from "../../packages/gateway/src/chat/outbox-delivery.js";
import type { CanonicalChatTransportFrame } from "@matrix-os/contracts";

it("decrypts only the authorized detail response, keeping repository state encrypted", async () => {
  const stored = { ...content(), messages: [], turns: [], runs: [], queuedTurns: [] };
  const service = createCanonicalChatService({
    async getDetailPage(requested: typeof owner) { return requested.ownerId === owner.ownerId ? stored : null; },
  } as never, { projectOwnerToolOutput: createOwnerToolOutputProjection(key, ["alice"]) });
  expect(JSON.stringify(await service.getDetail(owner, "chat_test", { limit: 20 }))).toContain("OPAQUE_PRIVATE_RESULT");
  expect(await service.getDetail({ type: "personal", ownerId: "bob" }, "chat_test", { limit: 20 })).toBeNull();
  expect(JSON.stringify(stored)).not.toContain("OPAQUE_PRIVATE_RESULT");
});

it("decrypts owner stream live/replay only, without modifying outbox or telemetry", async () => {
  const event: ChatOutboxEvent = { cursor: 1, chatId: "chat_test", revision: 1, eventType: "run.activity",
    createdAt: "2026-09-20T00:00:00.000Z", payload: { streamContent: content() } };
  let publish!: ChatOutboxSink;
  const telemetry: unknown[] = [];
  const stream = createCanonicalChatEventStream({
    projectOwnerToolOutput: createOwnerToolOutputProjection(key, ["alice"]),
    onCommittedEvent: input => { telemetry.push(input); },
    repository: {
      registerOutboxSink(sink) { publish = sink; return { dispose() {} }; },
      async replayOutboxWindow(requested) { return { events: requested.ownerId === "alice" ? [event] : [], gap: false }; },
    },
  });
  const alice: CanonicalChatTransportFrame[] = [], bob: CanonicalChatTransportFrame[] = [];
  try {
    for (const [userId, frames] of [["alice", alice], ["bob", bob]] as const) {
      await stream.open({ principal: { userId, source: "jwt" }, content: true,
        sink: { send(frame) { frames.push(frame); return true; }, close() {} } });
    }
    expect(JSON.stringify(alice)).toContain("OPAQUE_PRIVATE_RESULT");
    alice.length = 0;
    publish({ owner, event: { ...event, cursor: 2 } });
    expect(JSON.stringify(alice)).toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(bob)).not.toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(event)).not.toContain("OPAQUE_PRIVATE_RESULT");
    expect(JSON.stringify(telemetry)).not.toContain("OPAQUE_PRIVATE_RESULT");
  } finally { stream.shutdown(); }
});
