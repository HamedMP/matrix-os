import type { BotExecutor } from "./repositories/shared.js";
import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { BotRoutineProposalSchema, type BotRoutineProposal } from "@matrix-os/contracts";
const ref = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
export const RoutineAuthorizationSchema = z.object({
  accountId: ref,
  computerId: ref,
  grantRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  definitionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();
export type RoutineAuthorization = z.infer<typeof RoutineAuthorizationSchema>;
const EnvelopeSchema = z.object({
  proposal: BotRoutineProposalSchema,
  source: RoutineAuthorizationSchema
}).strict();
export function routineApprovalDigest(proposal: BotRoutineProposal, source: RoutineAuthorization): string {
  return createHash("sha256").update(JSON.stringify(EnvelopeSchema.parse({
    proposal,
    source
  }))).digest("hex");
}
export function routineSelection(proposal: BotRoutineProposal, source: RoutineAuthorization) {
  return {
    ...proposal.selection,
    options: [{
      id: "accountId",
      value: source.accountId
    }, {
      id: "grantRevision",
      value: String(source.grantRevision)
    }]
  };
}
export async function hasLiveRoutineChat(executor: BotExecutor, ownerId: string, botId: string, chatId: string): Promise<boolean> {
  const row = await executor.selectFrom("bot_chat_bindings as binding").innerJoin("chats as chat", "chat.id", "binding.chat_id").select("binding.chat_id").where("binding.owner_id", "=", ownerId).where("binding.bot_id", "=", botId).where("binding.chat_id", "=", chatId).where("binding.kind", "=", "direct").where("binding.removed_at", "is", null).where("chat.owner_type", "=", "personal").where("chat.owner_id", "=", ownerId).where("chat.collaboration", "is", null).where("chat.lifecycle", "=", "active").executeTakeFirst();
  return Boolean(row);
}
