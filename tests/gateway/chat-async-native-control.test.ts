import { expect, it, vi } from "vitest";
import { createHermesInputController } from "../../packages/gateway/src/chat/hermes-input-control.js";
import { createPiInputControl } from "../../packages/gateway/src/coding-agents/pi-input-control.js";
import { createOpenCodeInputController } from "../../packages/gateway/src/coding-agents/opencode-input.js";

it("releases Hermes clarification with a non-answer notice", async () => {
  const controller = createHermesInputController(); const request = vi.fn().mockResolvedValue({ status: "ok" }); const emit = vi.fn();
  const identity = { owner: { type: "personal" as const, ownerId: "owner_1" }, chatId: "chat_1", runId: "run_1" };
  controller.registerRun({ ...identity, client: { request } as never, emit });
  const question = controller.registerRequest(identity.runId, { request_id: "question_native", question: "Which color?", choices: ["Blue", "Red"] });
  await controller.defer({ ...identity, requestId: question.requestId });
  expect(request.mock.calls[0]![1].answer).toContain("user has NOT answered");
  expect(emit).not.toHaveBeenCalled();
  await expect(controller.defer({ ...identity, requestId: question.requestId })).rejects.toThrow();
});

it("releases Pi input without choosing one of its options or publishing a user answer", () => {
  const write = vi.fn(); const emit = vi.fn(); const controller = createPiInputControl({ threadId: "thread_test", now: () => new Date(), nextEventId: () => "evt_test", write, emit });
  controller.receive({ type: "extension_ui_request", id: "native", method: "select", title: "Color?", options: ["Blue", "Red"] });
  const requestId = emit.mock.calls[0]![0][0].request.requestId;
  controller.defer(requestId);
  expect(write.mock.calls[0]![0]).toMatchObject({ id: "native", type: "extension_ui_response", value: expect.stringContaining("user has NOT answered") });
  expect(emit).toHaveBeenCalledOnce();
  controller.dispose();
});

it("releases OpenCode's native tool with a notice, preserving real answers for a later phase", async () => {
  const emit = vi.fn(); const reply = vi.fn().mockResolvedValue(true); const controller = createOpenCodeInputController(emit, reply);
  controller.asked({ id: "native", sessionID: "session_native", questions: [{ header: "Color", question: "Color?", options: [{ label: "Blue", description: "Blue" }], custom: false }] });
  const requestId = emit.mock.calls[0]![0].requestId;
  await controller.defer(requestId);
  expect(reply).toHaveBeenCalledWith('/question/native/reply', { answers: [[expect.stringContaining("user has NOT answered")]] });
  expect(emit).toHaveBeenCalledOnce();
  await expect(controller.defer(requestId)).rejects.toThrow();
});
