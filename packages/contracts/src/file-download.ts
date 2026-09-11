import { z } from "zod/v4";

// Bound inactivity and header waits, not total size or transfer duration.
export const FILE_DOWNLOAD_TIMEOUT_MS = 30_000;
export const FILE_DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;

export const DownloadPathSchema = z.string().min(1).max(4096)
  .refine((path) => path === path.trim() && !/[\\\u0000-\u001f\u007f]/.test(path)
    && path.split("/").every((part) => part !== "" && part !== "." && part !== ".."));

export const FileDownloadRequestSchema = z.object({
  requestId: z.uuid(),
  path: DownloadPathSchema,
  runtimeSlot: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
  authGeneration: z.number().int().nonnegative(),
}).strict();
export type FileDownloadRequest = z.infer<typeof FileDownloadRequestSchema>;

export const FileDownloadErrorCodeSchema = z.enum([
  "busy", "unavailable", "failed", "destination_changed", "timeout",
]);
export type FileDownloadErrorCode = z.infer<typeof FileDownloadErrorCodeSchema>;
export const FileDownloadResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("saved") }).strict(),
  z.object({ status: z.literal("handed_off") }).strict(),
  z.object({ status: z.literal("cancelled") }).strict(),
  z.object({ status: z.literal("error"), code: FileDownloadErrorCodeSchema }).strict(),
]);
export type FileDownloadResult = z.infer<typeof FileDownloadResultSchema>;

const DOWNLOAD_ERRORS: Record<FileDownloadErrorCode, string> = {
  busy: "A download is already in progress. Wait or cancel it before trying again.",
  unavailable: "This file is unavailable. Refresh Files and check your connection.",
  failed: "Couldn’t download this file. Check your connection and save location, then try again.",
  destination_changed: "The file at the save location changed. Download again and choose a destination.",
  timeout: "The download timed out. Please try again.",
};
export function fileDownloadMessage(result: FileDownloadResult): string {
  if (result.status === "saved") return "Download saved.";
  if (result.status === "handed_off") return "Download sent to your browser. Check or cancel it in your browser’s downloads.";
  if (result.status === "cancelled") return "Download cancelled.";
  return DOWNLOAD_ERRORS[result.code];
}

// Treat the remote basename as a suggestion only. Local destination authority
// belongs to the native save dialog or the browser's download manager.
export function safeDownloadFilename(path: string): string {
  let name = (path.split("/").pop() ?? "download")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/[. ]+$/, "");
  if (!name || name === "." || name === "..") name = "download";
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) name = `_${name}`;
  const extension = /\.[a-zA-Z0-9]{1,16}$/.exec(name)?.[0] ?? "";
  const stem = extension ? name.slice(0, -extension.length) : name;
  const encoder = new TextEncoder();
  let bounded = "";
  for (const character of stem) {
    if (encoder.encode(bounded + character + extension).byteLength > 240) break;
    bounded += character;
  }
  return bounded + extension;
}
