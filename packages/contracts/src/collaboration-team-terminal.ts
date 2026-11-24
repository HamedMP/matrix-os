import { z } from "zod/v4";

import {
  COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT,
  CollaborationActorIdSchema,
  CollaborationIdSchema,
  CollaborationParticipantSchema,
  CollaborationRevisionSchema,
  CollaborationRoleSchema,
  CollaborationTerminalActionSchema,
  CollaborationTerminalConnectionIdSchema,
  CollaborationTerminalIncarnationSchema,
} from "#collaboration";
import { boundedDisplayText, boundedText } from "#legacy-contract-primitives";

/**
 * Team terminals (spec 2710): several editors type into one shared terminal
 * without a control lease, and the owner may pause collaborator input.
 * These actions extend the legacy terminal actions; every legacy action
 * keeps its exact shape so released clients are unaffected.
 */
export const CollaborationTeamTerminalInputModeSchema = z.enum(["shared", "owner"]);
export type CollaborationTeamTerminalInputMode = z.infer<typeof CollaborationTeamTerminalInputModeSchema>;

const TeamActionBaseSchema = z.object({
  clientRequestId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
}).strict();

const TeamInputBaseSchema = TeamActionBaseSchema.extend({
  connectionId: CollaborationTerminalConnectionIdSchema,
  data: boundedText(COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT, COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT).refine((value) => value.length > 0),
}).strict();

export const CollaborationTeamTerminalInputActionSchema = z.discriminatedUnion("type", [
  TeamInputBaseSchema.extend({ type: z.literal("input_shared") }).strict(),
  TeamInputBaseSchema.extend({ type: z.literal("paste_shared") }).strict(),
]);

export const CollaborationTeamTerminalInputModeActionSchema = TeamActionBaseSchema.extend({
  type: z.literal("input_mode"),
  mode: CollaborationTeamTerminalInputModeSchema,
}).strict();

/** Opts this connection into presence frames; released clients never send it, so they never receive them. */
export const CollaborationTeamTerminalPresenceSubscribeActionSchema = TeamActionBaseSchema.extend({
  type: z.literal("presence_subscribe"),
}).strict();

export const CollaborationTeamTerminalActionSchema = z.discriminatedUnion("type", [
  ...CollaborationTerminalActionSchema.options,
  ...CollaborationTeamTerminalInputActionSchema.options,
  CollaborationTeamTerminalInputModeActionSchema,
  CollaborationTeamTerminalPresenceSubscribeActionSchema,
]);
export type CollaborationTeamTerminalAction = z.infer<typeof CollaborationTeamTerminalActionSchema>;
export type CollaborationTeamTerminalInputAction = z.infer<typeof CollaborationTeamTerminalInputActionSchema>;

export function isTeamTerminalInputAction(action: CollaborationTeamTerminalAction): action is CollaborationTeamTerminalInputAction {
  return action.type === "input_shared" || action.type === "paste_shared";
}

/** Codes a collaborator sees for a refused shared input; the socket stays open. */
export const CollaborationTeamTerminalRejectionCodeSchema = z.enum(["forbidden", "input_paused", "rate_limited"]);
export type CollaborationTeamTerminalRejectionCode = z.infer<typeof CollaborationTeamTerminalRejectionCodeSchema>;

/** Sent only in answer to `input_shared` / `paste_shared`, which only team-terminal clients send. */
export const CollaborationTeamTerminalInputRejectedFrameSchema = z.object({
  version: z.literal(1),
  type: z.literal("terminal.input_rejected"),
  scopeId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
  clientRequestId: CollaborationIdSchema,
  code: CollaborationTeamTerminalRejectionCodeSchema,
}).strict();
export type CollaborationTeamTerminalInputRejectedFrame = z.infer<typeof CollaborationTeamTerminalInputRejectedFrameSchema>;

export const CollaborationTeamTerminalInputModeResultSchema = z.object({
  scopeId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
  inputMode: CollaborationTeamTerminalInputModeSchema,
}).strict();

export const TEAM_TERMINAL_MAX_PARTICIPANTS = 32;
export const TEAM_TERMINAL_MAX_MARKS_SENT = 64;
export const TEAM_TERMINAL_COMPUTER_LABEL_MAX_CHARS = 64;

/** Someone in a team terminal now: content-free and bounded. */
export const CollaborationTeamTerminalParticipantSchema = z.object({
  actorId: CollaborationActorIdSchema,
  displayName: boundedDisplayText(120, 512),
  role: CollaborationRoleSchema,
  /** Open collaborator sockets; the owner's own tab sockets are not counted. */
  connections: z.number().int().min(0).max(8),
  typingAt: z.iso.datetime().optional(),
}).strict();
export type CollaborationTeamTerminalParticipant = z.infer<typeof CollaborationTeamTerminalParticipantSchema>;

/** Who typed: actor, when, where in the output stream, how much, and whether Enter was pressed. Never the keys. */
export const CollaborationTeamTerminalMarkSchema = z.object({
  actorId: CollaborationActorIdSchema,
  at: z.iso.datetime(),
  outputSeq: CollaborationRevisionSchema,
  bytes: z.number().int().min(1).max(COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT),
  enter: z.boolean(),
}).strict();
export type CollaborationTeamTerminalMark = z.infer<typeof CollaborationTeamTerminalMarkSchema>;

export const CollaborationTeamTerminalPresenceStateSchema = z.object({
  inputMode: CollaborationTeamTerminalInputModeSchema,
  participants: z.array(CollaborationTeamTerminalParticipantSchema).max(TEAM_TERMINAL_MAX_PARTICIPANTS),
  marks: z.array(CollaborationTeamTerminalMarkSchema).max(TEAM_TERMINAL_MAX_MARKS_SENT),
}).strict();
export type CollaborationTeamTerminalPresenceState = z.infer<typeof CollaborationTeamTerminalPresenceStateSchema>;

export const CollaborationTeamTerminalPresenceFrameSchema = CollaborationTeamTerminalPresenceStateSchema.extend({
  version: z.literal(1),
  type: z.literal("terminal.presence"),
  scopeId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
}).strict();
export type CollaborationTeamTerminalPresenceFrame = z.infer<typeof CollaborationTeamTerminalPresenceFrameSchema>;

const CanonicalWorkspaceIdSchema = z.string().regex(/^tws_[a-f0-9]{32}$/);
const CanonicalTabIdSchema = z.string().regex(/^tt_[a-f0-9]{32}$/);

/** Owner feed on `/ws/terminal/events`: one entry per shared tab that someone is watching. */
export const TeamTerminalOwnerEntrySchema = CollaborationTeamTerminalPresenceStateSchema.extend({
  ref: z.object({ workspaceId: CanonicalWorkspaceIdSchema, tabId: CanonicalTabIdSchema }).strict(),
  scopeId: CollaborationIdSchema,
}).strict();
export type TeamTerminalOwnerEntry = z.infer<typeof TeamTerminalOwnerEntrySchema>;

export const TeamTerminalComputerLabelSchema = boundedDisplayText(TEAM_TERMINAL_COMPUTER_LABEL_MAX_CHARS, 256)
  .refine((value) => value.trim().length > 0);

/** Owner-only: the computer name members see under Team ("MacBook" shows as "Nima's MacBook"). */
export const TeamTerminalLabelRequestSchema = z.object({
  computerLabel: TeamTerminalComputerLabelSchema,
}).strict();

/** What a member's Team section shows for one shared terminal, hydrated from the owner's computer. */
export const TeamTerminalProjectionSchema = z.object({
  scopeId: CollaborationIdSchema,
  incarnation: CollaborationTerminalIncarnationSchema,
  terminalName: boundedDisplayText(256, 1024),
  computerLabel: TeamTerminalComputerLabelSchema.optional(),
  owner: CollaborationParticipantSchema,
  role: CollaborationRoleSchema,
  status: z.enum(["active", "exited"]),
  inputMode: CollaborationTeamTerminalInputModeSchema,
}).strict();
export type TeamTerminalProjection = z.infer<typeof TeamTerminalProjectionSchema>;
