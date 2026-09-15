import { z } from "zod/v4";
import { ASYNC_QUESTION_NOTICE } from "./async-input-notice.mjs";

export const CodexDeferredInputControlSchema = z.object({
  type: z.literal("defer_input"),
  requestId: z.string().regex(/^req_codex_[a-f0-9]{32}$/),
  clientRequestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/),
}).strict();

/** Socket-only OS control. No client-supplied answer or instruction enters this acknowledgement. */
export function deferCodexNativeInput(control, pendingInputs, sendProvider) {
  const pending = pendingInputs.get(control.requestId);
  if (!pending) return false;
  const answers = Object.fromEntries(pending.questions.map(question => [question.nativeQuestionId, { answers: [ASYNC_QUESTION_NOTICE] }]));
  sendProvider({ id: pending.nativeRequestId, result: { answers } });
  pendingInputs.delete(control.requestId);
  return true;
}
