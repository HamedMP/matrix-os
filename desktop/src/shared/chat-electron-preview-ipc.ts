import { z } from "zod/v4";

export const ChatElectronPreviewTarget = z.strictObject({
  chatId: z.string().regex(/^chat_[A-Za-z0-9_-]{1,128}$/),
  runId: z.string().regex(/^run_[A-Za-z0-9_-]{1,128}$/),
});

export const ChatElectronPreviewReply = z.strictObject({
  status: z.enum(["returned", "declined", "unavailable", "failed", "busy", "already-handled"]),
});

export const CHAT_ELECTRON_PREVIEW_INVOKE = {
  "chat:electron-preview-available": {
    request: z.strictObject({}),
    response: z.strictObject({ available: z.boolean() }),
  },
  "chat:electron-preview-run": {
    request: ChatElectronPreviewTarget,
    response: ChatElectronPreviewReply,
  },
} as const;

export type ChatElectronPreviewTarget = z.infer<typeof ChatElectronPreviewTarget>;
export type ChatElectronPreviewReply = z.infer<typeof ChatElectronPreviewReply>;
