import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { ownerSdkAdapterFixture } from "./owner-sdk-home-test-support.js";
import { createClaudeInputController } from "../../packages/gateway/src/chat/claude-input-control.js";
import { longClaudeQuestion } from "../fixtures/long-claude-question.js";

const createAdapter = ownerSdkAdapterFixture();
const request = (questions: unknown) => ({ type: "control_request", request_id: "native_question", request: {
  subtype: "can_use_tool", tool_name: "AskUserQuestion", input: { questions },
} });

it.each([false, true])("shows full long descriptions and answers on the same Claude stdin session after unsupported input: %s", async rejectFirst => {
  const stdout = new EventEmitter(); const stderr = new EventEmitter(); const process = new EventEmitter();
  const frames: Array<Record<string, unknown>> = [];
  const send = (frame: unknown) => stdout.emit("data", Buffer.from(`${JSON.stringify(frame)}\n`));
  const child = Object.assign(process, { stdout, stderr, kill: vi.fn(), stdin: {
    write(frame: string, callback?: (error?: Error | null) => void) {
      const parsed = JSON.parse(frame); frames.push(parsed); callback?.();
      queueMicrotask(() => {
        if (parsed.type === "user") send(rejectFirst ? { ...request(null), request: { ...request(null).request, input: null } } : request([longClaudeQuestion]));
        else if (parsed.type === "control_response" && parsed.response.response.behavior === "deny") send(request([longClaudeQuestion]));
        else if (parsed.type === "control_response") send({ type: "result", subtype: "success", result: "Review choice received." });
      }); return true;
    },
    end() { queueMicrotask(() => process.emit("exit", 0, null)); },
  } });
  const spawnFn = vi.fn(() => child);
  const adapter = createAdapter({ homePath: "/safe/home", spawnFn, resolveCredentialEnv: async () => ({}) });
  const owner = { type: "personal" as const, ownerId: "owner_question" };
  const stream = adapter.start({ owner, chatId: "chat_question", turnId: "turn_question", runId: "run_question", prompt: "Ask for a review choice", parts: [{ type: "text", text: "Ask for a review choice" }], selection: { instanceId: "claude_code_default", model: "default", options: [] }, interactionMode: "default", permissionMode: "auto", executionRoot: "/safe/project", signal: new AbortController().signal });
  const event = (await stream.next()).value;
  expect(event).toMatchObject({ type: "input.requested", questions: [{ options: longClaudeQuestion.options }] });
  await adapter.submitInput!({ owner, chatId: "chat_question", runId: "run_question", requestId: "native_question", clientRequestId: "req_answer", structuredAnswers: { q0: [longClaudeQuestion.options[0].label] } });
  const events = []; for await (const next of stream) events.push(next);
  expect(events).toContainEqual(expect.objectContaining({ type: "input.resolved", reason: "answered" }));
  expect(events.at(-1)).toEqual({ type: "run.completed", outcome: "completed" });
  const responses = frames.filter(frame => frame.type === "control_response");
  expect(responses).toHaveLength(rejectFirst ? 2 : 1);
  const response = responses.at(-1) as { response: { response: { behavior: string; updatedInput: { answers: Record<string, string> } } } };
  expect(response.response.response).toMatchObject({ behavior: "allow", updatedInput: { answers: { [longClaudeQuestion.question]: longClaudeQuestion.options[0].label } } });
  expect(child.kill).not.toHaveBeenCalled(); expect(spawnFn).toHaveBeenCalledOnce();
});

it.each([
  ["oversized", [{ ...longClaudeQuestion, options: [{ label: "Large", description: "x".repeat(65_537) }, longClaudeQuestion.options[1]] }]],
  ["malformed", [{ ...longClaudeQuestion, options: [{ label: "Invalid", description: null }, longClaudeQuestion.options[1]] }]],
  ["unsafe", [{ ...longClaudeQuestion, options: [{ label: "Invalid", description: "Read /home/private/file" }, longClaudeQuestion.options[1]] }]],
])("denies %s question input without throwing or admitting an input card", async (_name, questions) => {
  const write = vi.fn<(frame: string) => Promise<void>>().mockResolvedValue(undefined); const emit = vi.fn();
  const controller = createClaudeInputController({ write, emit });
  try {
    expect(() => controller.handle(request(questions))).not.toThrow();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0]![0]).response.response).toMatchObject({ behavior: "deny" });
    controller.handle(request([longClaudeQuestion]));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "input.requested" }));
  } finally { controller.close(); }
});

it("preserves denial transport failures without logging untrusted native error details", async () => {
  const error = new Error("private transport message");
  error.name = "private transport credential";
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const onError = vi.fn(); const emit = vi.fn();
  const controller = createClaudeInputController({ write: vi.fn().mockRejectedValue(error), emit, onError });
  try {
    controller.handle(request(null));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(error));
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private transport");
  } finally { controller.close(); warn.mockRestore(); }
});

it.each([{ name: "null", input: null }, { name: "array", input: [] }, { name: "missing", input: undefined }])("denies a malformed question input container: $name", async ({ input }) => {
  const frame = request([longClaudeQuestion]);
  const write = vi.fn<(frame: string) => Promise<void>>().mockResolvedValue(undefined); const emit = vi.fn();
  const controller = createClaudeInputController({ write, emit });
  try {
    expect(() => controller.handle({ ...frame, request: { ...frame.request, input } })).not.toThrow();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0]![0]).response.response.behavior).toBe("deny");
    controller.handle(frame);
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "input.requested" }));
  } finally { controller.close(); }
});

it("retains protocol failure handling for malformed envelopes and non-question tools", () => {
  const write = vi.fn(async () => undefined); const permission = vi.fn();
  const controller = createClaudeInputController({ write, emit: vi.fn(), onToolPermission: permission });
  const frame = request([longClaudeQuestion]);
  try {
    expect(() => controller.handle({ ...frame, request_id: "" })).toThrow();
    expect(() => controller.handle({ ...frame, request: { ...frame.request, tool_name: "Bash", input: null } })).toThrow();
    expect(write).not.toHaveBeenCalled();
    expect(permission).not.toHaveBeenCalled();
  } finally { controller.close(); }
});


it("denies a native list at the byte boundary when canonical projection exceeds it", async () => {
  const questions = [{ question: "Choose a sample workflow", header: "Workflow", options: [
    { label: "First", description: "x" }, { label: "Second", description: "Second explanation" },
  ] }];
  const overhead = Buffer.byteLength(JSON.stringify(questions)) - 1;
  questions[0]!.options[0]!.description = "x".repeat(65_536 - overhead);
  const projectedQuestions = questions.map((question, index) => ({ ...question, questionId: `q${index}`, allowOther: true, secret: false }));
  expect(Buffer.byteLength(JSON.stringify(questions))).toBe(65_536);
  expect(Buffer.byteLength(JSON.stringify(projectedQuestions))).toBeGreaterThan(65_536);
  const write = vi.fn<(frame: string) => Promise<void>>().mockResolvedValue(undefined); const emit = vi.fn();
  const controller = createClaudeInputController({ write, emit });
  try {
    expect(() => controller.handle(request(questions))).not.toThrow();
    await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
    expect(JSON.parse(write.mock.calls[0]![0]).response.response.behavior).toBe("deny");
    controller.handle(request([longClaudeQuestion]));
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: "input.requested" }));
  } finally { controller.close(); }
});
