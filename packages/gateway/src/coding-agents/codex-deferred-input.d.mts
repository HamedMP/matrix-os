import type { z } from "zod/v4";
export const CodexDeferredInputControlSchema: z.ZodObject<{
  type: z.ZodLiteral<"defer_input">;
  requestId: z.ZodString;
  clientRequestId: z.ZodString;
}>;
export function deferCodexNativeInput(
  control: { requestId: string },
  pendingInputs: Map<string, { nativeRequestId: string | number; questions: { nativeQuestionId: string }[] }>,
  sendProvider: (message: { id: string | number; result: { answers: Record<string, { answers: string[] }> } }) => void,
): boolean;
