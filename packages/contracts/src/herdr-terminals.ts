// Herdr sessions shown inside Matrix (spec 2701): the terminals held by the
// owner's own herdr-core, listed and attached through the gateway. Shared by
// the gateway, the shell, Electron Desktop and the CLI.
//
// Consumed as raw TS source by plain Node: import only from packages, never
// from "./module.js" siblings.
import { z } from "zod/v4";

/**
 * The workspace every Herdr terminal reports under in Matrix terminal refs, so
 * terminal verbs, events and attention treat it like any other tab. It has the
 * canonical `tws_` shape, ends in "herdr" in hex, and is never minted by the
 * terminal runtime (its ids are random).
 */
export const HERDR_TERMINAL_WORKSPACE_ID = "tws_00000000000000000000006865726472";

/** herdr-core's own terminal address format. */
export const HerdrSessionIdSchema = z.string().regex(/^t[0-9]{1,6}[a-z]{0,2}$/);

export const HerdrAvailabilitySchema = z.enum(["not-installed", "unsupported", "unavailable", "ready"]);
export type HerdrAvailability = z.infer<typeof HerdrAvailabilitySchema>;

export const HerdrSessionStatusSchema = z.enum(["idle", "working", "done", "blocked", "error"]);
export type HerdrSessionStatus = z.infer<typeof HerdrSessionStatusSchema>;

export const HERDR_SESSION_LIST_MAX = 500;

const SAFE_TEXT = /^[^\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]*$/;

export const HerdrSessionSchema = z.strictObject({
  id: HerdrSessionIdSchema,
  /** The Matrix tab id for this terminal under HERDR_TERMINAL_WORKSPACE_ID. */
  tabId: z.string().regex(/^tt_[0-9a-f]{32}$/),
  title: z.string().min(1).max(256).regex(SAFE_TEXT),
  status: HerdrSessionStatusSchema.nullable(),
  /** Opaque connected-core and process incarnation used for explicit Chat selection. */
  revision: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  statusMessage: z.string().max(200).regex(SAFE_TEXT).optional(),
});
export type HerdrSession = z.infer<typeof HerdrSessionSchema>;

export const HerdrSessionListSchema = z.strictObject({
  available: z.boolean(),
  status: HerdrAvailabilitySchema,
  sessions: z.array(HerdrSessionSchema).max(HERDR_SESSION_LIST_MAX),
});
export type HerdrSessionList = z.infer<typeof HerdrSessionListSchema>;

/** Whether a terminal ref names a Herdr terminal rather than a Matrix one. */
export function isHerdrTerminalRef(ref: { workspaceId: string } | null | undefined): boolean {
  return ref?.workspaceId === HERDR_TERMINAL_WORKSPACE_ID;
}

/** The "Herdr sessions" group is shown only for a reachable core with at least one terminal (spec 2701 decision 2). */
export function shouldShowHerdrSessions(list: HerdrSessionList | null | undefined): boolean {
  return list?.available === true && list.sessions.length > 0;
}
