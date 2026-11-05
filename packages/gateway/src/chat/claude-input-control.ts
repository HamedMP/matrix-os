import { z } from "zod/v4";
import { MAX_USER_INPUT_QUESTIONS_BYTES, type CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import { inputSubmissionGate, nativeInputId, questionAnswers, secretQuestion } from "./native-input-control.js";
const QuestionSchema = z.object({
  question: z.string().min(1).max(600), header: z.string().min(1).max(160),
  options: z.array(z.object({ label: z.string().min(1).max(160), description: z.string().min(1).max(MAX_USER_INPUT_QUESTIONS_BYTES) })).min(2).max(4),
  multiSelect: z.boolean().optional(),
});
const RequestSchema = z.object({ type: z.literal("control_request"), request_id: z.string().min(1).max(256),
  request: z.object({ subtype: z.literal("can_use_tool"), tool_name: z.string().min(1).max(256), input: z.unknown() }),
});
type InputEvent = Extract<CanonicalProviderRunEvent, { type: "input.requested" }>;
export const CLAUDE_HUMAN_INPUT_TTL_MS = 30 * 60_000;
export function createClaudeInputController(options: { write(frame: string): Promise<void>; emit(event: CanonicalProviderRunEvent): void; onError?(error: unknown): void;
  signal?: AbortSignal;
  onToolPermission?: (request: { nativeRequestId: string; toolName: string; input: Record<string, unknown> }, respond: (response: unknown) => Promise<void>) => boolean;
  onToolPermissionCancel?: (nativeRequestId: string) => void;
}) {
  const pending = new Map<string, { nativeId: string; input: Record<string, unknown>; questions: z.infer<typeof QuestionSchema>[]; event: InputEvent;
    timer: ReturnType<typeof setTimeout>; expire(): void }>(); // max 16; removed on answer, cancellation, expiry and close
  let closed = false;
  const submit = inputSubmissionGate();
  const respond = (requestId: string, response: unknown) => closed || options.signal?.aborted
    ? Promise.reject(new Error("Input transport unavailable"))
    : options.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: requestId, response } })}\n`);
  const denyUnsupportedQuestion = (nativeId: string) => {
    void respond(nativeId, { behavior: "deny", message: "This question is too large or unsupported. Ask a shorter question with valid choices." }).catch((error: unknown) => {
      console.warn("[chat-claude] Unsupported question response failed");
      options.onError?.(error);
    });
  };
  const resolve = (requestId: string, reason: "answered" | "cancelled" | "expired") => {
    const request = pending.get(requestId);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(requestId);
    options.emit(CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId, reason }));
  };
  const close = () => {
    if (closed) return;
    closed = true;
    options.signal?.removeEventListener("abort", close);
    for (const requestId of pending.keys()) resolve(requestId, "cancelled");
  };
  if (options.signal?.aborted) close();
  else options.signal?.addEventListener("abort", close, { once: true });
  return {
    handle(value: unknown): boolean {
      if (closed) return true;
      const frame = z.object({ type: z.string(), request_id: z.string().optional() }).passthrough().parse(value);
      if (frame.type === "control_cancel_request") {
        if (frame.request_id) {
          options.onToolPermissionCancel?.(frame.request_id);
          const requestId = nativeInputId(frame.request_id);
          resolve(requestId, "cancelled");
        }
        return true;
      }
      if (frame.type !== "control_request") return false;
      const request = RequestSchema.parse(value);
      const parsedInput = z.record(z.string(), z.unknown()).safeParse(request.request.input);
      if (!parsedInput.success) {
        if (request.request.tool_name !== "AskUserQuestion") throw parsedInput.error;
        denyUnsupportedQuestion(request.request_id); return true;
      }
      const nativeInput = parsedInput.data;
      if (request.request.tool_name !== "AskUserQuestion") {
        if (options.onToolPermission?.({ nativeRequestId: request.request_id, toolName: request.request.tool_name,
          input: nativeInput }, response => respond(request.request_id, response))) return true;
        // Do not turn the stdio permission callback into implicit tool approval.
        void respond(request.request_id, { behavior: "deny", message: "Tool approval is unavailable in this Chat connection." }).catch(error => {
          console.warn("[chat-claude] Permission response failed", error instanceof Error ? error.name : "UnknownError");
          options.onError?.(error);
        });
        return true;
      }
      const requestId = nativeInputId(request.request_id);
      if (pending.has(requestId)) return true;
      if (pending.size >= 16) throw new Error("Input request limit exceeded");
      const rawQuestions = nativeInput.questions;
      // Bound the original question list, including unknown fields, before projecting it.
      if (!Array.isArray(rawQuestions) || Buffer.byteLength(JSON.stringify(rawQuestions), "utf8") > MAX_USER_INPUT_QUESTIONS_BYTES) {
        denyUnsupportedQuestion(request.request_id); return true;
      }
      const parsedQuestions = z.array(QuestionSchema).min(1).max(4).safeParse(rawQuestions);
      if (!parsedQuestions.success) { denyUnsupportedQuestion(request.request_id); return true; }
      const questions = parsedQuestions.data;
      const projected = CanonicalProviderRunEventSchema.safeParse({ type: "input.requested", requestId, title: "Input needed",
        expiresAt: new Date(Date.now() + CLAUDE_HUMAN_INPUT_TTL_MS).toISOString(),
        questions: questions.map((question, index) => ({ questionId: `q${index}`, ...question, ...(secretQuestion(question.question) ? { question: "Enter the requested sensitive value.", options: undefined } : {}), allowOther: true, secret: secretQuestion(question.question) })),
      });
      // Admission stays strict even though shared readers accept released shapes
      // whose aggregate size predates the expanded-description budget.
      if (!projected.success || projected.data.type !== "input.requested" || !projected.data.questions
        || Buffer.byteLength(JSON.stringify(projected.data.questions), "utf8") > MAX_USER_INPUT_QUESTIONS_BYTES) {
        denyUnsupportedQuestion(request.request_id); return true;
      }
      const event = projected.data;
      const expire = () => {
        if (closed || pending.get(requestId) !== current) return;
        resolve(requestId, "expired");
        void respond(request.request_id, { behavior: "deny", message: "This input request expired before an answer." }).catch(error => {
          console.warn("[chat-claude] Expired input response failed", error instanceof Error ? error.name : "UnknownError");
          options.onError?.(error);
        });
      };
      const timer = setTimeout(expire, CLAUDE_HUMAN_INPUT_TTL_MS);
      timer.unref?.();
      const current = { nativeId: request.request_id, input: nativeInput, questions, event, timer, expire };
      pending.set(requestId, current);
      options.emit(event);
      return true;
    },
    submit(input: CanonicalSubmitChatInputRequest & { requestId: string }) {
      return submit(input.requestId, input, async () => {
        const request = pending.get(input.requestId);
        if (!request || closed) throw new Error("Input request unavailable");
        // Timers can run late when the event loop is busy; the deadline is authoritative.
        if (Date.now() >= Date.parse(request.event.expiresAt!)) {
          request.expire();
          throw new Error("Input request expired");
        }
        const values = questionAnswers(request.event.questions!, input);
        const answers = Object.fromEntries(request.questions.map((question, index) => [question.question, values[index]!.join(", ")]));
        // An on-time answer claims the response. Stdin acceptance keeps its existing 10s bound;
        // never race an already-started allow with an expiry denial or replay an uncertain write.
        clearTimeout(request.timer);
        try {
          await respond(request.nativeId, { behavior: "allow", updatedInput: { ...request.input, answers } });
        } catch (error: unknown) {
          if (pending.get(input.requestId) === request) resolve(input.requestId, "cancelled");
          console.warn("[chat-claude] Input response failed", error instanceof Error ? error.name : "UnknownError");
          options.onError?.(error);
          throw error;
        }
        if (pending.get(input.requestId) !== request) throw new Error("Input request cancelled");
        resolve(input.requestId, "answered");
      });
    },
    close,
  };
}
