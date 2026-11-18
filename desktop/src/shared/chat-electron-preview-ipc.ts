import { z } from "zod/v4";
import { CanonicalChatIdSchema, CanonicalChatRunIdSchema } from "@matrix-os/contracts";

export const ChatElectronPreviewTarget = z.strictObject({
  chatId: CanonicalChatIdSchema,
  runId: CanonicalChatRunIdSchema,
  requestKind: z.literal("verification").optional(),
});

export const ChatElectronPreviewReply = z.strictObject({
  status: z.enum(["returned", "declined", "unavailable", "failed", "busy", "already-handled"]),
});

export const CHAT_ELECTRON_PREVIEW_INVOKE = {
  "chat:electron-preview-available": {
    request: z.strictObject({}),
    response: z.strictObject({ available: z.boolean(), verificationAvailable: z.boolean().optional() }),
  },
  "chat:electron-preview-run": {
    request: ChatElectronPreviewTarget,
    response: ChatElectronPreviewReply,
  },
} as const;

export type ChatElectronPreviewTarget = z.infer<typeof ChatElectronPreviewTarget>;
export type ChatElectronPreviewReply = z.infer<typeof ChatElectronPreviewReply>;
