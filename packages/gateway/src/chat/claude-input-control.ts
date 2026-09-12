import { z } from "zod/v4";
import type { CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import { inputSubmissionGate, nativeInputId, questionAnswers, secretQuestion } from "./native-input-control.js";
const QuestionSchema = z.object({
  question: z.string().min(1).max(600), header: z.string().min(1).max(160),
  options: z.array(z.object({ label: z.string().min(1).max(160), description: z.string().min(1).max(300) })).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
const RequestSchema = z.object({ type: z.literal("control_request"), request_id: z.string().min(1).max(256),
  request: z.object({ subtype: z.literal("can_use_tool"), tool_name: z.string().min(1).max(256), input: z.record(z.string(), z.unknown()) }),
});
type InputEvent = Extract<CanonicalProviderRunEvent, { type: "input.requested" }>;
export function createClaudeInputController(options: { write(frame: string): Promise<void>; emit(event: CanonicalProviderRunEvent): void; onError?(error: unknown): void }) {
  const pending = new Map<string, { nativeId: string; input: Record<string, unknown>; questions: z.infer<typeof QuestionSchema>[]; event: InputEvent }>();
  const submit = inputSubmissionGate();
  const respond = (requestId: string, response: unknown) => options.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`);
  return {
    handle(value: unknown): boolean {
      const frame = z.object({ type: z.string(), request_id: z.string().optional() }).passthrough().parse(value);
      if (frame.type === "control_cancel_request") {
        if (frame.request_id) {
          const requestId = nativeInputId(frame.request_id);
          if (pending.delete(requestId)) options.emit(CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId, reason: "cancelled" }));
        }
        return true;
      }
      if (frame.type !== "control_request") return false;
      const request = RequestSchema.parse(value);
      if (request.request.tool_name !== "AskUserQuestion") {
        // Do not turn the stdio permission callback into implicit tool approval.
        void respond(request.request_id, { behavior: "deny", message: "Tool approval is unavailable in this Chat connection." }).catch(error => {
          console.warn("[chat-claude] Permission response failed", error instanceof Error ? error.name : "UnknownError");
          options.onError?.(error);
        });
        return true;
      }
      if (pending.size >= 16) throw new Error("Input request limit exceeded");
      const questions = z.array(QuestionSchema).min(1).max(4).parse(request.request.input.questions);
      const requestId = nativeInputId(request.request_id);
      if (pending.has(requestId)) return true;
      const event = CanonicalProviderRunEventSchema.parse({ type: "input.requested", requestId, title: "Input needed",
        questions: questions.map((question, index) => ({ questionId: `q${index}`, ...question, ...(secretQuestion(question.question) ? { question: "Enter the requested sensitive value.", options: undefined } : {}), allowOther: true, secret: secretQuestion(question.question) })),
      }) as InputEvent;
      pending.set(requestId, { nativeId: request.request_id, input: request.request.input, questions, event });
      options.emit(event);
      return true;
    },
    submit(input: CanonicalSubmitChatInputRequest & { requestId: string }) {
      return submit(input.requestId, input, async () => {
        const request = pending.get(input.requestId);
        if (!request) throw new Error("Input request unavailable");
        const values = questionAnswers(request.event.questions!, input);
        const answers = Object.fromEntries(request.questions.map((question, index) => [question.question, values[index]!.join(", ")]));
        await respond(request.nativeId, { behavior: "allow", updatedInput: { ...request.input, answers } });
        if (pending.get(input.requestId) !== request) throw new Error("Input request cancelled");
        pending.delete(input.requestId);
        options.emit(CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId: input.requestId, reason: "answered" }));
      });
    },
  };
}
