import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema } from "./canonical-chat.js";
import { canonicalReferenceId } from "./canonical-chat-primitives.js";

export const MAC_VERIFICATION_TERMINAL_MAX_AGE_MS = 10 * 60 * 1_000;
export const MAC_VERIFICATION_TERMINAL_MAX_BYTES = 1024;

export const MAC_VERIFICATION_SOURCE_BY_RECIPE = {
  "sign-in": "desktop/src/renderer/src/features/signin/SignIn.tsx",
  "files-trash": "desktop/src/renderer/src/features/files/ComputerFileBrowser.tsx",
} as const;

export const MacVerificationFilesMenuLabelSchema = z.string()
  .regex(/^[A-Za-z][A-Za-z0-9 .!?-]{2,54}$/)
  .refine(value => value === value.trim());
export const MacVerificationRecipeSchema = z.enum(["sign-in", "files-trash"]);
export type MacVerificationRecipe = z.infer<typeof MacVerificationRecipeSchema>;

export const MacVerificationTerminalIntentSchema = z.strictObject({
  version: z.literal(1),
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  projectId: canonicalReferenceId(160),
  worktreeId: z.string().regex(/^wt_[a-z0-9]{12,40}$/),
  recipe: MacVerificationRecipeSchema,
  baseSha: z.string().regex(/^[a-f0-9]{40}$/),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type MacVerificationTerminalIntent = z.infer<typeof MacVerificationTerminalIntentSchema>;

export async function macVerificationTerminalIntentPath(chatId: string, runId: string): Promise<string> {
  const binding = JSON.stringify([CanonicalChatIdSchema.parse(chatId), CanonicalChatRunIdSchema.parse(runId)]);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(binding));
  const id = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `temporary/desktop-chat/mac-verification-${id}.json`;
}
