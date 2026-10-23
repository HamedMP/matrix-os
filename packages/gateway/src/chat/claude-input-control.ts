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
      if (request.request.tool_name !== "AskUserQuestion") {
        if (options.onToolPermission?.({ nativeRequestId: request.request_id, toolName: request.request.tool_name,
          input: request.request.input }, response => respond(request.request_id, response))) return true;
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
      const questions = z.array(QuestionSchema).min(1).max(4).parse(request.request.input.questions);
      const event = CanonicalProviderRunEventSchema.parse({ type: "input.requested", requestId, title: "Input needed",
        expiresAt: new Date(Date.now() + CLAUDE_HUMAN_INPUT_TTL_MS).toISOString(),
        questions: questions.map((question, index) => ({ questionId: `q${index}`, ...question, ...(secretQuestion(question.question) ? { question: "Enter the requested sensitive value.", options: undefined } : {}), allowOther: true, secret: secretQuestion(question.question) })),
      }) as InputEvent;
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
      const current = { nativeId: request.request_id, input: request.request.input, questions, event, timer, expire };
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
