import { z } from "zod/v4";

import {
  COLLABORATION_TERMINAL_INPUT_BYTE_LIMIT,
  CollaborationIdSchema,
  CollaborationTerminalActionSchema,
  CollaborationTerminalConnectionIdSchema,
  CollaborationTerminalIncarnationSchema,
} from "#collaboration";
import { boundedText } from "#legacy-contract-primitives";

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

export const CollaborationTeamTerminalActionSchema = z.discriminatedUnion("type", [
  ...CollaborationTerminalActionSchema.options,
  ...CollaborationTeamTerminalInputActionSchema.options,
  CollaborationTeamTerminalInputModeActionSchema,
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
