import { z } from "zod/v4";
import { CollaborationOrganizationIdSchema } from "./collaboration-identity.js";

/**
 * "Make app collaborative" handoff between the Share popover and Matrix Chats
 * (spec 2693 phase 2, builder skill specs/2689-collaborative-app-sharing/builder-skill.md).
 *
 * Record: `~/system/share/collaborative/<appSlug>.json`. Files are the OS's
 * inspectable state surface, so the owner (and the kernel) can read it.
 *
 *  1. Share popover writes `{ state: "running" }` when the owner picks
 *     "Start in Chats" for an organization.
 *  2. The `matrix-collaborative-app-builder` skill, when its build and owner
 *     preflight pass, rewrites the record with the same `requestId` and
 *     `state: "completed"` (or `"failed"`). This is the AUTOMATIC completion
 *     event; the owner does nothing.
 *  3. The Share host notices the change, rechecks 2689 readiness for that
 *     organization, and creates the org share ONLY if readiness is `ready`
 *     (the server preflight enforces this again). A completion event never
 *     shares by itself.
 *
 * After the share is created the host writes `state: "applied"` so a later
 * "Stop sharing" is never undone by a stale completion. Owner cancel writes
 * `state: "cancelled"`. The record holds no secrets.
 */
export const COLLABORATIVE_HANDOFF_DIRECTORY = "system/share/collaborative";
export const COLLABORATIVE_HANDOFF_MAX_BYTES = 2048;
export const COLLABORATIVE_HANDOFF_EVENT = "collaborative_app.preparation" as const;

export const CollaborativeHandoffAppSlugSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const CollaborativeHandoffStateSchema = z.enum(["running", "completed", "failed", "cancelled", "applied"]);

export const CollaborativeHandoffRecordSchema = z.object({
  version: z.literal(1),
  event: z.literal(COLLABORATIVE_HANDOFF_EVENT),
  requestId: z.uuid(),
  appSlug: CollaborativeHandoffAppSlugSchema,
  organizationId: CollaborationOrganizationIdSchema,
  state: CollaborativeHandoffStateSchema,
  updatedAt: z.iso.datetime(),
}).strict();
export type CollaborativeHandoffRecord = z.infer<typeof CollaborativeHandoffRecordSchema>;
export type CollaborativeHandoffState = z.infer<typeof CollaborativeHandoffStateSchema>;

export function collaborativeHandoffPath(appSlug: string): string {
  return `${COLLABORATIVE_HANDOFF_DIRECTORY}/${CollaborativeHandoffAppSlugSchema.parse(appSlug)}.json`;
}

/** Validate a handoff file's parsed JSON; anything malformed or oversized reads as "no handoff". */
export function parseCollaborativeHandoff(value: unknown, appSlug: string): CollaborativeHandoffRecord | null {
  if (JSON.stringify(value ?? null).length > COLLABORATIVE_HANDOFF_MAX_BYTES) return null;
  const parsed = CollaborativeHandoffRecordSchema.safeParse(value);
  return parsed.success && parsed.data.appSlug === appSlug ? parsed.data : null;
}
