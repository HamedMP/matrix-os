import { RoutineCliOperationSchema } from "#bots/routine-cli";
import { z } from "zod/v4";

export const ROUTINE_ACTION_PROOF_HEADER = "x-matrix-routine-action-proof";
export const ROUTINE_ACTION_PATH = "/api/routine-cli/actions";
export const RoutineActionIdSchema = z.string().regex(/^rcact_[a-f0-9]{32}$/);
export const RoutineActionDecisionSchema = z.enum(["approve", "decline", "cancel"]);
export const RoutineActionSubmitSchema = z.strictObject({
  actionDigest: z.string().regex(/^[a-f0-9]{64}$/), decision: RoutineActionDecisionSchema,
  clientRequestId: z.union([z.uuid(), z.string().regex(/^req_[a-f0-9]{32}$/)]).transform(value => value.toLowerCase()),
});
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
/** actionDigest commits to the host's complete source/invocation/operation/target/policy tuple.
 * Selectors and this DTO never constitute authority without a matching live stored challenge. */
export const RoutineActionTupleSchema = RoutineActionSubmitSchema.extend({
  handle: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), runtimeSlot: ref, machineId: ref, ownerId: ref,
  challengeId: RoutineActionIdSchema,
});
export const RoutineActionProofSchema = RoutineActionTupleSchema.extend({
  purpose: z.literal("routine_cli_owner_action"), version: z.literal(1),
  expiresAt: z.number().int().positive(), nonce: z.string().regex(/^[a-f0-9]{32}$/), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const ROUTINE_ACTION_NOTICE = "Allow this operation only. Routine activation, background model consent and integration permissions remain separate.";
export const RoutineActionViewSchema = z.strictObject({
  challengeId: RoutineActionIdSchema, actionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceKind: z.enum(["chat_run", "terminal_launch", "bot_child"]),
  operation: z.enum(["propose", "pause", "resume", "archive"]),
  expiresAt: z.iso.datetime({ offset: true }), status: z.enum(["pending", "approved", "declined", "cancelled", "expired", "unavailable"]),
  intent: RoutineCliOperationSchema, target: z.strictObject({ botId: ref, chatId: ref }), sourceLabel: z.string().max(300),
  title: z.string().max(160), description: z.literal(ROUTINE_ACTION_NOTICE),
}).refine(view => view.intent.operation === view.operation);
export type RoutineActionSubmit = z.infer<typeof RoutineActionSubmitSchema>;
export type RoutineActionTuple = z.infer<typeof RoutineActionTupleSchema>;
export type RoutineActionProof = z.infer<typeof RoutineActionProofSchema>;
export type RoutineActionView = z.infer<typeof RoutineActionViewSchema>;
export function routineActionConfirmationUrl(appOrigin: string, gatewayPath: string, challengeId: string): string {
  const origin = new URL(appOrigin);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Confirmation unavailable");
  if (!/^\/vm\/[a-z0-9][a-z0-9-]{0,62}(?:\?[^#\s]*)?$/.test(gatewayPath)) throw new Error("Confirmation unavailable");
  const url = new URL(gatewayPath, origin);
  if (url.origin !== origin.origin || !/^\/vm\/[a-z0-9][a-z0-9-]{0,62}$/.test(url.pathname) || url.hash
    || [...url.searchParams.keys()].some(key => key !== "runtime") || url.searchParams.getAll("runtime").length > 1
    || url.searchParams.has("runtime") && !ref.safeParse(url.searchParams.get("runtime")).success) throw new Error("Confirmation unavailable");
  url.pathname += "/routine-cli/confirm";
  url.searchParams.set("challenge", RoutineActionIdSchema.parse(challengeId));
  return url.toString();
}

export const ROUTINE_ACTION_OUTCOME = { pending: "Awaiting your decision", approved: "This operation was allowed", declined: "This operation was declined", cancelled: "This request was cancelled", expired: "This request expired", unavailable: "This request is unavailable" } as const;
export function routineActionDetails(view: RoutineActionView): string {
  return `${view.sourceLabel}\nDestination ${view.target.botId} / ${view.target.chatId}\n${JSON.stringify(view.intent, null, 2)}`;
}
