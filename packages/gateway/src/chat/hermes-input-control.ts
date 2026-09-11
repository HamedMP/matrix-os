import { createHash } from "node:crypto";
import { z } from "zod/v4";
import type { CanonicalOwnerScope, CanonicalSubmitChatInputRequest } from "@matrix-os/contracts";
import { CanonicalProviderRunEventSchema, type CanonicalProviderRunEvent } from "./provider-adapter.js";
import type { HermesStdioClient } from "./hermes-stdio-client.js";
import { inputSubmissionGate, nativeInputId, questionAnswers, secretQuestion } from "./native-input-control.js";
import { boundedOperation } from "../bounded-operation.js";
const QuestionSchema = z.object({
  qid: z.string().min(1).max(256).optional(), question: z.string().min(1).max(600),
  choices: z.array(z.string().min(1).max(160)).max(10).nullish(), multi_select: z.boolean().optional(),
});
const RequestSchema = z.object({
  request_id: z.string().min(1).max(256), question: z.string().min(1).max(600).optional(),
  choices: QuestionSchema.shape.choices, multi_select: z.boolean().optional(),
  questions: z.array(QuestionSchema.extend({ qid: z.string().min(1).max(256) })).min(1).max(8).optional(),
});
type InputEvent = Extract<CanonicalProviderRunEvent, { type: "input.requested" }>;
type Run = { owner: CanonicalOwnerScope; chatId: string; runId: string; client: HermesStdioClient; emit(event: CanonicalProviderRunEvent): void };
export function createHermesInputController() {
  const runs = new Map<string, Run & { pending: Map<string, { nativeId: string; questions: z.infer<typeof QuestionSchema>[]; event: InputEvent; sent: number; fingerprint?: string }>; submit: ReturnType<typeof inputSubmissionGate> }>();
  function expire(runId: string, nativeId: string) {
    const run = runs.get(runId); const requestId = nativeInputId(nativeId);
    if (run?.pending.delete(requestId)) run.emit(CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId, reason: "expired" }));
  }
  return {
    registerRun(input: Run) {
      if (runs.size >= 128 && !runs.has(input.runId)) throw new Error("Input Run limit exceeded");
      const run = { ...input, pending: new Map(), submit: inputSubmissionGate() };
      runs.set(input.runId, run);
      return () => { if (runs.get(input.runId) === run) runs.delete(input.runId); };
    },
    registerRequest(runId: string, value: unknown): InputEvent {
      const request = RequestSchema.parse(value); const run = runs.get(runId);
      if (!run || run.pending.size >= 16) throw new Error("Input Run unavailable");
      const questions = request.questions ?? [QuestionSchema.parse(request)];
      const requestId = nativeInputId(request.request_id);
      const existing = run.pending.get(requestId);
      if (existing) return existing.event;
      const event = CanonicalProviderRunEventSchema.parse({ type: "input.requested", requestId, title: "Input needed",
        questions: questions.map((question, index) => ({ questionId: nativeInputId(question.qid ?? `q${index}`), header: `Question ${index + 1}`,
          question: secretQuestion(question.question) ? "Enter the requested sensitive value." : question.question, ...(!secretQuestion(question.question) && question.choices?.length ? { options: question.choices.map(label => ({ label, description: label })) } : {}),
          multiSelect: question.multi_select ?? false, allowOther: true, secret: secretQuestion(question.question),
        })),
      }) as InputEvent;
      run.pending.set(requestId, { nativeId: request.request_id, questions, event, sent: 0 });
      return event;
    },
    expire,
    async submit(input: CanonicalSubmitChatInputRequest & { owner: CanonicalOwnerScope; chatId: string; runId: string; requestId: string }) {
      const run = runs.get(input.runId);
      if (!run || run.chatId !== input.chatId || run.owner.type !== input.owner.type || run.owner.ownerId !== input.owner.ownerId) throw new Error("Input Run unavailable");
      return run.submit(input.requestId, input, async () => {
        const pending = run.pending.get(input.requestId);
        if (!pending) throw new Error("Input request unavailable");
        const answers = questionAnswers(pending.event.questions!, input);
        const fingerprint = createHash("sha256").update(JSON.stringify(answers)).digest("hex");
        if (pending.sent > 0 && pending.fingerprint !== fingerprint) throw new Error("Input answers already partially submitted");
        pending.fingerprint = fingerprint;
        for (let index = pending.sent; index < pending.questions.length; index++) {
          const question = pending.questions[index]!;
          const result = await boundedOperation(() => run.client.request("clarify.respond", {
            request_id: pending.nativeId, ...(question.qid ? { question_id: question.qid } : {}),
            answer: question.multi_select ? JSON.stringify(answers[index]) : answers[index]![0],
          }), 10_000);
          const response = z.object({ status: z.enum(["ok", "expired"]) }).parse(result);
          if (response.status === "expired") { expire(input.runId, pending.nativeId); throw new Error("Input request expired"); }
          pending.sent = index + 1;
        }
        if (run.pending.get(input.requestId) !== pending) throw new Error("Input request expired");
        run.pending.delete(input.requestId);
        run.emit(CanonicalProviderRunEventSchema.parse({ type: "input.resolved", requestId: input.requestId, reason: "answered" }));
      });
    },
  };
}
