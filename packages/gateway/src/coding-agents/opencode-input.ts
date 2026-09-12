import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { UserInputQuestionListSchema, type UserInputAnswerRequest } from "@matrix-os/contracts";
import { questionAnswers } from "../chat/native-input-control.js";
const NativeRequest = z.object({
  id: z.string().min(1).max(256), sessionID: z.string().min(1).max(512),
  questions: z.array(z.object({
    header: z.string().min(1).max(160), question: z.string().min(1).max(600),
    options: z.array(z.object({ label: z.string().min(1).max(160), description: z.string().max(300) })).max(10),
    multiple: z.boolean().optional(), custom: z.boolean().optional(),
  })).min(1).max(8),
});
export function createOpenCodeInputController(emit: (record: Record<string, unknown>) => void, reply: (path: string, body?: unknown) => Promise<unknown>) {
  const pending = new Map<string, { nativeId: string; questions: z.infer<typeof UserInputQuestionListSchema>; correlationId: string }>();
  const claims = new Set<string>();
  function identity(nativeId: string) { return createHash("sha256").update(nativeId).digest("hex").slice(0, 32); }
  return {
    asked(value: unknown) {
      const native = NativeRequest.parse(value);
      const hash = identity(native.id); const requestId = `req_opencode_${hash}`;
      if (pending.has(requestId)) return;
      if (pending.size >= 16 || claims.size >= 128) throw new Error("OpenCode input limit reached");
      const questions = UserInputQuestionListSchema.parse(native.questions.map((q, index) => ({
        questionId: `q${index}`, header: q.header, question: q.question,
        ...(q.options.length ? { options: q.options.map(option => ({ ...option, description: option.description || option.label })) } : {}),
        multiSelect: q.multiple ?? false, allowOther: q.custom ?? true, secret: false,
      })));
      const correlationId = `corr_opencode_${hash}`;
      pending.set(requestId, { nativeId: native.id, questions, correlationId });
      emit({ type: "matrix.input.requested", sessionID: native.sessionID, requestId, questions, correlationId });
    },
    resolved(nativeId: string, reason: "answered" | "cancelled") {
      const requestId = `req_opencode_${identity(nativeId)}`;
      const request = pending.get(requestId);
      if (!request) return;
      pending.delete(requestId);
      emit({ type: "matrix.input.resolved", requestId, correlationId: request.correlationId, reason });
    },
    async submit(requestId: string, input: UserInputAnswerRequest) {
      const request = pending.get(requestId);
      if (!request || claims.has(requestId) || input.correlationId !== request.correlationId) throw new Error("OpenCode input unavailable");
      const answers = questionAnswers(request.questions, input);
      if (answers.some(values => new Set(values).size !== values.length)) throw new Error("Duplicate input choice");
      claims.add(requestId);
      // Once admitted, an unknown HTTP failure must never replay the answer.
      const result = await reply(`/question/${encodeURIComponent(request.nativeId)}/reply`, { answers });
      if (result !== true) throw new Error("OpenCode input unconfirmed");
      this.resolved(request.nativeId, "answered");
    },
    clear() { pending.clear(); claims.clear(); },
  };
}
