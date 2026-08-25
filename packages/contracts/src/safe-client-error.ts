import { z } from "zod/v4";
import { SAFE_SLUG } from "#contract-primitives";
import { boundedText } from "#legacy-contract-primitives";

const UNSAFE_ERROR_TEXT =
  /(postgres|sqlite|mysql|pipedream|twilio|openai|anthropic|constraint|stack trace|zod|issues|\/home\/|\/tmp\/|\/var\/|\.ssh\/|id_rsa|bearer\s+[A-Za-z0-9._-]+|sk-[A-Za-z0-9_-]+)/i;
const SafeErrorTextSchema = boundedText(180, 720)
  .refine((value) => !UNSAFE_ERROR_TEXT.test(value), {
    message: "Text is not safe for clients",
  });

export const RecoveryActionSchema = z.enum([
  "retry",
  "sign_in",
  "select_runtime",
  "open_setup_terminal",
  "resume",
  "start_new_session",
  "return_home",
]);

export const SafeClientErrorSchema = z.object({
  code: z.string().min(1).max(80).regex(SAFE_SLUG),
  safeMessage: SafeErrorTextSchema,
  retryable: z.boolean(),
  recoveryActions: z.array(RecoveryActionSchema).max(6).optional(),
}).strict();

export type SafeClientError = z.infer<typeof SafeClientErrorSchema>;
