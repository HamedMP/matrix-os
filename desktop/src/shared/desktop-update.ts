import { z } from "zod/v4";

export const MAX_DESKTOP_RELEASE_NOTES_LENGTH = 32 * 1024;

export const DesktopUpdateVersionSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);

export const DesktopUpdateStatusSchema = z.enum([
  "disabled",
  "checking",
  "up-to-date",
  "downloading",
  "ready",
  "error",
]);

export const DesktopUpdateSnapshotSchema = z
  .object({
    status: DesktopUpdateStatusSchema,
    version: DesktopUpdateVersionSchema.optional(),
    progress: z.number().min(0).max(100).optional(),
  })
  .strict();

export const DesktopReleaseNotesSchema = z
  .object({
    version: DesktopUpdateVersionSchema,
    releaseDate: z.string().datetime().optional(),
    notes: z.string().max(MAX_DESKTOP_RELEASE_NOTES_LENGTH),
  })
  .strict();

export type DesktopUpdateStatus = z.infer<typeof DesktopUpdateStatusSchema>;
export type DesktopUpdateSnapshot = z.infer<typeof DesktopUpdateSnapshotSchema>;
export type DesktopReleaseNotes = z.infer<typeof DesktopReleaseNotesSchema>;
