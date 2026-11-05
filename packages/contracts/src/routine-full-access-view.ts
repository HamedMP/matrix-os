import { z } from "zod/v4";
import { BotIdSchema } from "#bots/ids";
import { CanonicalChatIdSchema } from "#canonical-chat";
import { RoutineFullAccessIdSchema } from "#routine-full-access";

const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scope = { expiresAt: z.iso.datetime({ offset: true }), policyRevision: revision,
  actions: z.tuple([z.literal("read"), z.literal("propose"), z.literal("control")]),
  target: z.strictObject({ botId: BotIdSchema, chatId: CanonicalChatIdSchema }) };
/** Safe UI projection only; native incarnation, preference, nonce and proof stay server-only. */
export const RoutineFullAccessStatusSchema = z.strictObject({
  revision, eligibility: z.enum(["eligible", "unavailable", "ineligible", "target_required"]),
  consent: z.strictObject({ ...scope, scopeId: RoutineFullAccessIdSchema }).nullable(),
  challenge: z.strictObject({ ...scope, challengeId: RoutineFullAccessIdSchema, scopeDigest: z.string().regex(/^[a-f0-9]{64}$/) }).nullable(),
  origin: z.literal("browser_required"),
});
export const RoutineFullAccessCreateChallengeSchema = z.strictObject({ baseRevision: revision });
export const RoutineFullAccessRevokeSchema = z.strictObject({ baseRevision: revision });
export type RoutineFullAccessStatus = z.infer<typeof RoutineFullAccessStatusSchema>;
export type RoutineFullAccessCreateChallenge = z.infer<typeof RoutineFullAccessCreateChallengeSchema>;
export type RoutineFullAccessRevoke = z.infer<typeof RoutineFullAccessRevokeSchema>;
