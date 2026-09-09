import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { KyselyPGlite } from "kysely-pglite";
import { ChatRepository } from "../../packages/gateway/src/chat/repository.js";
import { createCanonicalChatEventStream } from "../../packages/gateway/src/chat/event-stream.js";
import { createChatFailureRecorder } from "../../packages/gateway/src/chat/failure-telemetry.js";
import { diagnoseChatRunFailure } from "../../packages/gateway/src/chat/failure-diagnostic.js";
import { createGatewayChatEventStream } from "../../packages/gateway/src/chat/gateway-event-stream.js";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat.js";

let repository: ChatRepository;
let stream: ReturnType<typeof createCanonicalChatEventStream>;
const owner = { type: "personal" as const, ownerId: "owner_failure" };
beforeEach(async () => {
  const db = await KyselyPGlite.create();
  repository = new ChatRepository(db.dialect);
  await repository.bootstrap();
});

it("records a safe failure category and stage without shipping the exception text or stack", async () => {
  const capture = vi.fn();
  stream = createCanonicalChatEventStream({ repository, onCommittedEvent: createChatFailureRecorder({ capture }) });
  const ids = await runningChat();
  const error = new Error("token=private-secret /home/private/db");
  error.name = "TimeoutError";
  await repository.finishRun(owner, { ...ids, outcome: "failed", completedAt: "2026-09-09T00:00:02.000Z",
    diagnostic: diagnoseChatRunFailure(error, "provider") });
  expect(capture).toHaveBeenCalledWith("matrix_agent_run_failed", expect.objectContaining({
    properties: expect.objectContaining({ failure_stage: "provider", error_category: "timeout", error_reason: "Operation timed out" }),
  }));
  expect(JSON.stringify(capture.mock.calls)).not.toMatch(/private-secret|\/home\/private|stack/);
});
afterEach(async () => { stream?.shutdown(); await repository.kysely.destroy(); });

async function runningChat() {
  const { snapshot } = createCanonicalChatFixture("running");
  const chatId = snapshot.chat.id;
  await repository.create(owner, { id: chatId, clientRequestId: "req_failure", title: "Private chat title" });
  const { startedAt: _startedAt, ...run } = snapshot.runs[0]!;
  await repository.admitTurn(owner, { chatId, baseRevision: 0, message: snapshot.messages[0]!,
    turn: { ...snapshot.turns[0]!, status: "accepted" }, run: { ...run, status: "accepted" } });
  await repository.markRunRunning(owner, { chatId, runId: run.id, startedAt: "2026-09-09T00:00:00.000Z" });
  return { chatId, runId: run.id };
}

it("captures a committed agent failure without a browser and does not count retries or replay twice", async () => {
  const capture = vi.fn();
  stream = createGatewayChatEventStream({ repository, capture,
    runtimeVersion: "0.0.0-dev.test", buildSha: "a64c785727a7357eac43d5c77c59987b82e08c93" });
  const ids = await runningChat();
  await repository.appendRunActivities(owner, ids.chatId, ids.runId, [{ ...ids, id: "activity_failure", type: "run.error",
    occurredAt: "2026-09-09T00:00:02.000Z", error: { code: "provider_unavailable", safeMessage: "Private diagnostic text", retryable: true } }]);
  const failure = { ...ids, outcome: "failed" as const, completedAt: "2026-09-09T00:00:02.000Z" };
  await repository.finishRun(owner, failure);
  await repository.finishRun(owner, failure);
  for (let i = 0; i < 2; i++) {
    await stream.open({ principal: { userId: owner.ownerId, source: "jwt" }, sink: { send: () => true, close() {} } });
  }
  expect(capture).toHaveBeenCalledTimes(1);
  expect(capture).toHaveBeenCalledWith("matrix_agent_run_failed", expect.objectContaining({
    distinctId: owner.ownerId,
    properties: expect.objectContaining({ chat_id: ids.chatId, run_id: ids.runId, failure_kind: "execution",
      error_code: "provider_unavailable", duration_ms: 2000, provider: "codex", failure_stage: "execution",
      error_reason: "Agent provider unavailable", runtime_version: "0.0.0-dev.test",
      build_sha: "a64c785727a7357eac43d5c77c59987b82e08c93" }),
  }));
  expect(JSON.stringify(capture.mock.calls)).not.toMatch(/Private|Fix the failing/);
});

it("retains diagnostics when a large transcript cannot fit in a realtime content frame", async () => {
  const capture = vi.fn();
  stream = createCanonicalChatEventStream({ repository, onCommittedEvent: createChatFailureRecorder({ capture }) });
  const ids = await runningChat();
  for (let i = 0; i < 6; i++) {
    await repository.appendAssistantDelta(owner, { ...ids, messageId: `msg_large_${i}`, delta: "秘".repeat(30_000),
      createdAt: "2026-09-09T00:00:01.000Z" });
  }
  await repository.appendRunActivities(owner, ids.chatId, ids.runId, [{ ...ids, id: "activity_large_failure", type: "run.error",
    occurredAt: "2026-09-09T00:00:02.000Z", error: { code: "authorization_failed", safeMessage: "Do not export this", retryable: false } }]);
  await repository.finishRun(owner, { ...ids, outcome: "failed", completedAt: "2026-09-09T00:00:02.000Z" });
  expect(capture).toHaveBeenCalledWith("matrix_agent_run_failed", expect.objectContaining({
    properties: expect.objectContaining({ error_code: "authorization_failed", error_reason: "Authorization failed", provider: "codex", duration_ms: 2000 }),
  }));
  expect(JSON.stringify(capture.mock.calls)).not.toMatch(/秘|Do not export/);
});

it.each(["throw", "reject"])("isolates a PostHog %s from durable completion and realtime delivery", async (mode) => {
  const logger = { warn: vi.fn() };
  const capture = vi.fn(() => {
    if (mode === "throw") throw new Error("secret-telemetry-error");
    return Promise.reject(new Error("secret-telemetry-error"));
  });
  stream = createCanonicalChatEventStream({ repository, onCommittedEvent: createChatFailureRecorder({ capture, logger }) });
  const ids = await runningChat();
  const frames: unknown[] = [];
  await stream.open({ principal: { userId: owner.ownerId, source: "jwt" }, sink: { send(frame) { frames.push(frame); return true; }, close() {} } });
  await repository.finishRun(owner, { ...ids, outcome: "failed", completedAt: "2026-09-09T00:00:02.000Z" });
  expect((await repository.exportChat(owner, ids.chatId))?.runs[0]?.status).toBe("failed");
  expect(JSON.stringify(frames)).toContain("run.failed");
  await vi.waitFor(() => expect(logger.warn).toHaveBeenCalled());
  expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret-telemetry-error");
});
