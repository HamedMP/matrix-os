import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema, CanonicalChatActionDigestSchema, ProjectIdSchema, WorktreeIdSchema } from "@matrix-os/contracts";

export const ChatElectronPreviewTarget = z.strictObject({
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  requestKind: z.literal("verification").optional(),
  terminalIntentDigest: CanonicalChatActionDigestSchema.optional(),
});

export const ChatElectronPreviewReply = z.strictObject({
  status: z.enum(["returned", "declined", "unavailable", "failed", "busy", "already-handled"]),
});

const MacVerificationChatScope = z.strictObject({
  chatId: CanonicalChatIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
});

export type MacVerificationChatScope = z.infer<typeof MacVerificationChatScope>;

export const CHAT_ELECTRON_PREVIEW_INVOKE = {
  "chat:electron-preview-available": {
    request: z.strictObject({}),
    response: z.strictObject({ available: z.boolean(), verificationAvailable: z.boolean().optional(), terminalRequests: z.boolean().optional() }),
  },
  "chat:mac-verification-selection": {
    request: z.strictObject({ viewId: z.uuid(), scope: MacVerificationChatScope.nullable() }),
    response: z.strictObject({ accepted: z.boolean() }),
  },
  "chat:mac-verification-terminal-intent": {
    request: ChatElectronPreviewTarget.pick({ chatId: true, runId: true }),
    response: z.strictObject({ digest: CanonicalChatActionDigestSchema.nullable() }),
  },
  "chat:electron-preview-run": {
    request: ChatElectronPreviewTarget.extend({ fullAccessViewId: z.uuid().optional() })
      .refine(input => !(input.fullAccessViewId || input.terminalIntentDigest) || input.requestKind === "verification"),
    response: ChatElectronPreviewReply,
  },
} as const;

export type ChatElectronPreviewTarget = z.infer<typeof ChatElectronPreviewTarget>;
export type ChatElectronPreviewReply = z.infer<typeof ChatElectronPreviewReply>;
