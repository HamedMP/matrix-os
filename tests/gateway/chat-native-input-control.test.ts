import { describe, expect, it, vi } from "vitest";
import { createHermesInputController } from "../../packages/gateway/src/chat/hermes-input-control.js";
import { createClaudeInputController } from "../../packages/gateway/src/chat/claude-input-control.js";
const identity = { owner: { type: "personal" as const, ownerId: "owner_test" }, chatId: "chat_test", runId: "run_test" };
describe("native input controls", () => {
  it("answers Hermes batch questions using original native identities and resolves after acknowledgement", async () => {
    const controller = createHermesInputController();
    const request = vi.fn().mockResolvedValue({ status: "ok" });
    const emit = vi.fn();
    controller.registerRun({ ...identity, client: { request } as never, emit });
    const event = controller.registerRequest(identity.runId, { request_id: "native/id", questions: [{ qid: "native/q1", question: "Which color?", choices: ["Blue", "Red"] }, { qid: "q2", question: "Why?" }] });
    expect(event.questions).toHaveLength(2);
    await controller.submit({ ...identity, requestId: event.requestId, clientRequestId: "req_answer", structuredAnswers: { [event.questions![0]!.questionId]: ["Blue"], [event.questions![1]!.questionId]: ["Fits"] } });
    expect(request.mock.calls).toEqual([["clarify.respond", { request_id: "native/id", question_id: "native/q1", answer: "Blue" }], ["clarify.respond", { request_id: "native/id", question_id: "q2", answer: "Fits" }]]);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "input.resolved", requestId: event.requestId }));
  });
  it("rejects an expired Hermes native response without claiming it was answered", async () => {
    const controller = createHermesInputController(); const emit = vi.fn();
    controller.registerRun({ ...identity, client: { request: vi.fn().mockResolvedValue({ status: "expired" }) } as never, emit });
    const event = controller.registerRequest(identity.runId, { request_id: "native", question: "Name?" });
    await expect(controller.submit({ ...identity, requestId: event.requestId, clientRequestId: "req_answer", answer: "Joe" })).rejects.toThrow();
    expect(emit).not.toHaveBeenCalledWith(expect.objectContaining({ reason: "answered" }));
  });
  it("uses Claude control_response with original question text and never starts a new turn", async () => {
    const write = vi.fn(async () => undefined); const emit = vi.fn();
    const controller = createClaudeInputController({ write, emit });
    controller.handle({ type: "control_request", request_id: "native/id", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ header: "Color", question: "Which color?", options: [{ label: "Blue", description: "Ocean" }, { label: "Red", description: "Fire" }], multiSelect: false }] } } });
    const event = emit.mock.calls[0]![0];
    await controller.submit({ requestId: event.requestId, clientRequestId: "req_answer", structuredAnswers: { [event.questions[0].questionId]: ["Blue"] } });
    expect(JSON.parse(write.mock.calls[0]![0])).toMatchObject({ type: "control_response", response: { subtype: "success", request_id: "native/id", response: { behavior: "allow", updatedInput: { answers: { "Which color?": "Blue" } } } } });
    expect(emit).toHaveBeenLastCalledWith(expect.objectContaining({ type: "input.resolved" }));
  });
  it("does not approve other Claude tools implicitly", async () => {
    const write = vi.fn(async () => undefined);
    const controller = createClaudeInputController({ write, emit: vi.fn() });
    controller.handle({ type: "control_request", request_id: "native_other", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "rm file" } } });
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    expect(JSON.parse(write.mock.calls[0]![0]).response.response.behavior).toBe("deny");
  });
});

it("keeps accepted Hermes batch answers stable across a partial submission failure", async () => {
  const controller = createHermesInputController(); const emit = vi.fn();
  const request = vi.fn().mockResolvedValueOnce({ status: "ok" }).mockRejectedValueOnce(new Error("disconnected")).mockResolvedValue({ status: "ok" });
  controller.registerRun({ ...identity, client: { request } as never, emit });
  const event = controller.registerRequest(identity.runId, { request_id: "batch", questions: [{ qid: "first", question: "First?" }, { qid: "second", question: "Second?" }] });
  const input = { ...identity, requestId: event.requestId, clientRequestId: "req_batch", structuredAnswers: { first: ["one"], second: ["two"] } };
  await expect(controller.submit(input)).rejects.toThrow();
  await expect(controller.submit({ ...input, structuredAnswers: { first: ["changed"], second: ["two"] } })).rejects.toThrow();
  await controller.submit(input);
  expect(request.mock.calls.map(call => call[1].question_id)).toEqual(["first", "second", "second"]);
  expect(emit).toHaveBeenCalledOnce();
});

it("rejects another owner's Hermes answer and duplicate conflicting answers", async () => {
  const controller = createHermesInputController(); const request = vi.fn().mockResolvedValue({ status: "ok" });
  controller.registerRun({ ...identity, client: { request } as never, emit: vi.fn() });
  const event = controller.registerRequest(identity.runId, { request_id: "single", question: "Pick?", choices: ["One", "Two"], multi_select: true });
  const input = { ...identity, requestId: event.requestId, clientRequestId: "req_single", structuredAnswers: { q0: ["One", "Two"] } };
  await expect(controller.submit({ ...input, owner: { ...identity.owner, ownerId: "other" } })).rejects.toThrow();
  await controller.submit(input); await controller.submit(input);
  expect(request).toHaveBeenCalledOnce();
  expect(request.mock.calls[0]![1].answer).toBe('["One","Two"]');
  await expect(controller.submit({ ...input, clientRequestId: "req_conflicting" })).rejects.toThrow();
});

it("does not answer a cancelled Claude control request", async () => {
  const write = vi.fn(async (_frame: string) => undefined); const emit = vi.fn();
  const controller = createClaudeInputController({ write, emit });
  controller.handle({ type: "control_request", request_id: "cancel_me", request: { subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions: [{ question: "Pick?", header: "Pick", options: [{ label: "A", description: "A" }, { label: "B", description: "B" }] }] } } });
  controller.handle({ type: "control_cancel_request", request_id: "cancel_me" });
  await expect(controller.submit({ requestId: "cancel_me", clientRequestId: "req_answer", structuredAnswers: { q0: ["A"] } })).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
  expect(emit).toHaveBeenLastCalledWith({ type: "input.resolved", requestId: "cancel_me", reason: "cancelled" });
});
