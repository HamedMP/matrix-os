import { z } from "zod/v4";

export const TERMINAL_CLIPBOARD_MAX_FILES = 8;
export const TERMINAL_CLIPBOARD_MAX_BYTES = 10 * 1024 * 1024;
export const TerminalClipboardResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("empty") }).strict(),
  z.object({
    status: z.literal("files"),
    files: z.array(z.object({
      name: z.string().min(1).max(255),
      mimeType: z.literal("application/octet-stream"),
      dataBase64: z.string().max(Math.ceil(TERMINAL_CLIPBOARD_MAX_BYTES / 3) * 4),
    }).strict()).min(1).max(TERMINAL_CLIPBOARD_MAX_FILES),
  }).strict(),
  z.object({
    status: z.literal("error"),
    error: z.enum(["too_many_files", "too_large", "file_unavailable"]),
  }).strict(),
]);
export type TerminalClipboardResult = z.infer<typeof TerminalClipboardResultSchema>;
