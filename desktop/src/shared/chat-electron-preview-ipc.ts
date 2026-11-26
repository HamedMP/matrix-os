import { z } from "zod/v4";
import { MacVerificationRecipeSchema } from "@matrix-os/contracts/mac-verification-terminal";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatActionDigestSchema, ProjectIdSchema, WorktreeIdSchema } from "@matrix-os/contracts";

export const ChatElectronPreviewTarget = z.strictObject({
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  requestKind: z.literal("verification").optional(),
  terminalIntentDigest: CanonicalChatActionDigestSchema.optional(),
  recipeSelection: MacVerificationRecipeSchema.or(z.literal("changed-only")).optional(),
});

export const ChatElectronPreviewReply = z.strictObject({
  status: z.enum(["returned", "declined", "unavailable", "failed", "busy", "already-handled", "incompatible"]),
});

export const MATCHING_MAC_BUILD = "Install a signed Matrix Desktop build that matches this worktree revision.";
const PreviewRunRef = ChatElectronPreviewTarget.pick({ chatId: true, runId: true });

const MacVerificationChatScope = z.strictObject({
  chatId: CanonicalChatIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
});

export type MacVerificationChatScope = z.infer<typeof MacVerificationChatScope>;

export const CHAT_ELECTRON_PREVIEW_INVOKE = {
  "chat:electron-preview-available": {
    request: z.strictObject({ target: PreviewRunRef.optional() }),
    response: z.strictObject({ available: z.boolean(), verificationAvailable: z.boolean().optional(), terminalRequests: z.boolean().optional() }),
  },
  "chat:mac-verification-selection": {
    request: z.strictObject({ viewId: z.uuid(), scope: MacVerificationChatScope.nullable() }),
    response: z.strictObject({ accepted: z.boolean() }),
  },
  "chat:mac-verification-terminal-intent": {
    request: PreviewRunRef,
    response: z.strictObject({ digest: CanonicalChatActionDigestSchema.nullable() }),
  },
  "chat:electron-preview-run": {
    request: ChatElectronPreviewTarget.extend({ fullAccessViewId: z.uuid().optional() })
      .refine(input => !(input.fullAccessViewId || input.terminalIntentDigest || input.recipeSelection) || input.requestKind === "verification")
      .refine(input => !(input.terminalIntentDigest && input.recipeSelection)),
    response: ChatElectronPreviewReply,
  },
} as const;

export type ChatElectronPreviewTarget = z.infer<typeof ChatElectronPreviewTarget>;
export type ChatElectronPreviewReply = z.infer<typeof ChatElectronPreviewReply>;
