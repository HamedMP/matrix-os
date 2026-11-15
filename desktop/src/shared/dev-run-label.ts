import { z } from "zod/v4";

/** Unpacked-only presentation of which dev build a window is, for side-by-side PR testing. */
export const DEV_RUN_LABEL_MAX = 80;
const Origin = z.string().min(1).max(256).regex(/^https?:\/\/[A-Za-z0-9.:[\]-]+$/);
export const DesktopDevRunSummarySchema = z.strictObject({
  label: z.string().min(1).max(DEV_RUN_LABEL_MAX),
  sha: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  branch: z.string().min(1).max(128).regex(/^[A-Za-z0-9._/-]+$/).nullable(),
  platformOrigin: Origin.nullable(),
  apiOrigin: Origin.nullable(),
});
export type DesktopDevRunSummary = z.infer<typeof DesktopDevRunSummarySchema>;

// eslint-disable-next-line no-control-regex -- stripping control characters is the point.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Returns the sanitized label, or null when unset, blank, or running from a packaged build. */
export function parseDesktopDevRunLabel(raw: string | undefined, isPackaged: boolean): string | null {
  if (isPackaged || typeof raw !== "string") return null;
  // Truncate by whole code points but bound UTF-16 length, matching DesktopDevRunSummarySchema.label.
  let label = "";
  for (const char of raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim()) {
    if (label.length + char.length > DEV_RUN_LABEL_MAX) break;
    label += char;
  }
  label = label.trim();
  return label.length > 0 ? label : null;
}

export function desktopDevRunTitle(label: string): string {
  return `Matrix OS — ${label}`;
}
