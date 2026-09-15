import { z } from "zod/v4";

export const PREVIEW_TERMINAL_HEADER = "x-platform-preview-terminal";
export const PREVIEW_TERMINAL_MAX_AGE_SECONDS = 30;
export const PREVIEW_TERMINAL_SIGNATURE_DOMAIN = "preview-terminal-v1:";
const UserId = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);

/** Server-attested preview classification; never a client-selected access role. */
export const PreviewTerminalDelegationSchema = z.object({
  version: z.literal(1),
  scope: z.literal("preview-terminal"),
  provisioningClass: z.literal("preview"),
  role: z.literal("preview-collaborator"),
  actorId: UserId,
  ownerId: UserId,
  handle: z.string().max(64).regex(/^pr-[1-9][0-9]{0,9}$/),
  runtimeSlot: z.string().max(64),
  issuedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
}).strict().refine((value) => value.runtimeSlot === value.handle || value.runtimeSlot === "preview");
export type PreviewTerminalDelegation = z.infer<typeof PreviewTerminalDelegationSchema>;

export function isPreviewTerminalPath(path: string): boolean {
  return path.startsWith("/api/terminal/") || path === "/ws/terminal/tab";
}
