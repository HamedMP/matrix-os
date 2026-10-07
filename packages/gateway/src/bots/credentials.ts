import { z } from "zod/v4";
import { KernelCredentialAccessSourceIdSchema } from "../kernel-credentials.js";

// Bot-only extension: ordinary kernel credentials retain their existing schema.
export const BotCredentialAccessSourceIdSchema = z.union([
  KernelCredentialAccessSourceIdSchema, z.literal("owner_openai_profile"), z.literal("matrix_chatgpt_plan"),
]);
export type BotCredentialAccessSourceId = z.infer<typeof BotCredentialAccessSourceIdSchema>;
export type BotInferenceAuthorization = { allowed: false } | {
  allowed: true;
  accessSourceId?: BotCredentialAccessSourceId;
  allowedModelIds: readonly string[];
  allowedEgressOrigins: readonly string[];
};
