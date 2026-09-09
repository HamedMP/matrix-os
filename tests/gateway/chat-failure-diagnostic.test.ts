import { afterEach, expect, it, vi } from "vitest";
import { diagnoseChatRunFailure } from "../../packages/gateway/src/chat/failure-diagnostic.js";
import { captureChatFailureMetadata, createChatFailureRecorder } from "../../packages/gateway/src/chat/failure-telemetry.js";
import type { ChatOutboxEvent } from "../../packages/gateway/src/chat/records.js";

afterEach(() => vi.restoreAllMocks());

it.each(["throw", "reject"])("safely handles non-Error telemetry %s values", async (mode) => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const capture = () => {
    if (mode === "throw") throw "private-value";
    return Promise.reject("private-value");
  };
  createChatFailureRecorder({ capture })({ owner, event: event("run.failed", {}) });
  await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  expect(warn.mock.calls[0]?.[0]).toContain("UnknownError");
  expect(JSON.stringify(warn.mock.calls)).not.toContain("private-value");
});

it.each([
  [null, "unknown"],
  [new Error("private message"), "unknown"],
  [Object.assign(new Error(), { name: "TimeoutError" }), "timeout"],
  [Object.assign(new Error(), { name: "ZodError" }), "validation"],
  [Object.assign(new Error(), { name: "ChatConflictError" }), "state_conflict"],
  [Object.assign(new Error(), { name: "ChatBusyError" }), "state_conflict"],
  [new Error("Provider assistant output exceeded the canonical limit"), "resource_limit"],
  [Object.assign(new Error(), { code: "ETIMEDOUT" }), "timeout"],
  [Object.assign(new Error(), { code: "ECONNRESET" }), "network"],
  [Object.assign(new Error(), { code: "EACCES" }), "authorization"],
  [Object.assign(new Error(), { code: "secret code" }), "unknown"],
  [Object.assign(new Error(), { code: 403 }), "unknown"],
])("classifies errors without including private data (%#)", (error, category) => {
  expect(diagnoseChatRunFailure(error, "preparation")).toEqual({ stage: "preparation", category });
});

const owner = { type: "personal" as const, ownerId: "owner_diagnostic" };
function event(eventType: ChatOutboxEvent["eventType"], payload: Record<string, unknown>): ChatOutboxEvent {
  return { cursor: 1, chatId: "chat_diagnostic", revision: 1, eventType, payload, createdAt: "2026-09-09T00:00:00.000Z" };
}

it("ignores ordinary activity without traversing the transcript", () => {
  const capture = vi.fn();
  const recorder = createChatFailureRecorder({ capture });
  const payload = { get streamContent() { throw new Error("Transcript must not be traversed"); } };
  recorder({ owner, event: event("run.activity", payload) });
  recorder({ owner, event: event("run.completed", payload) });
  expect(capture).not.toHaveBeenCalled();
  expect(captureChatFailureMetadata("run.completed", undefined, undefined)).toBeUndefined();
});

it("uses safe unknown metadata when a legacy failure frame is missing content", () => {
  const capture = vi.fn();
  createChatFailureRecorder({ capture, runtimeVersion: "token=private", buildSha: "/private" })({
    owner, event: event("run.failed", { runId: 42, streamContent: { invalid: true } }),
  });
  expect(capture).toHaveBeenCalledWith("matrix_agent_run_failed", expect.objectContaining({
    properties: expect.objectContaining({ provider: "other", run_status: "unknown", error_category: "unknown",
      runtime_version: undefined, build_sha: undefined, run_id: undefined }),
  }));
});
