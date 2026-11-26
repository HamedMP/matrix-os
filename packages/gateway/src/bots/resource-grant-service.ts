import { createHash, randomUUID } from "node:crypto";
import type { Transaction } from "kysely";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import type { ChatDatabase } from "../chat/database.js";
import { privateBotSourceChat } from "../chat/private-routine-authority.js";
import {
  BotResourceGrantCandidateIdSchema,
  BotResourceGrantCreateResponseSchema,
  BotResourceGrantIdSchema,
  BotResourceGrantListSchema,
  BotResourceGrantRevokeResponseSchema,
  BotResourceGrantSchema,
  BotRevisionSchema,
  ChatAgentIdSchema,
} from "@matrix-os/contracts";
import {
  ResourceProviderCandidateSchema,
  type BotResourceGrantCandidate,
  type BotResourceGrantProviders,
  type BotResourceGrantTarget,
} from "./resource-grant-scope.js";
import type { BotStateTransactions } from "./events.js";
import {
  createBotResourceGrantsRepository,
  findPrivateResourceBinding,
  isGrantForBinding,
} from "./repositories/resource-grants.js";
import { toSafeInteger, type BotExecutor } from "./repositories/shared.js";

export type { BotResourceGrantCandidate, BotResourceGrantProviders } from "./resource-grant-scope.js";

export class BotResourceGrantError extends Error {
  constructor(readonly code: "missing" | "denied" | "conflict") {
    super(`Bot resource grant refused: ${code}`);
    this.name = "BotResourceGrantError";
  }
}

type GrantRepository = ReturnType<typeof createBotResourceGrantsRepository>;
type GrantRecord = Awaited<ReturnType<GrantRepository["list"]>>[number];
type Binding = NonNullable<Awaited<ReturnType<typeof findPrivateResourceBinding>>>;

function view(row: GrantRecord) {
  return BotResourceGrantSchema.parse({ id: row.grant_id, kind: row.kind, label: row.label, revision: toSafeInteger(row.revision) });
}

function candidateId(binding: Binding, candidate: BotResourceGrantCandidate, revision = 0) {
  return `source_${createHash("sha256")
    .update(JSON.stringify([binding.ownerId, binding.agentId, binding.chatId, binding.bindingCreatedAt,
      candidate.connectionId, candidate.scope, revision]))
    .digest("hex").slice(0, 48)}`;
}

function currentGrant(row: GrantRecord, binding: Binding) {
  return row.revoked_at === null && isGrantForBinding(row, binding);
}

async function requireBinding(db: BotExecutor, ownerId: string, agentId: string): Promise<Binding> {
  if (!ChatAgentIdSchema.safeParse(agentId).success) throw new BotResourceGrantError("missing");
  const found = await findPrivateResourceBinding(db, ownerId, agentId);
  if (!found) throw new BotResourceGrantError("missing");
  return found;
}

/** Revalidate selected candidates on the server. A recipe or submitted provider ID carries no authority. */
export function createBotResourceGrantService(deps: {
  transact: BotStateTransactions;
  providers: BotResourceGrantProviders;
  isActiveManagedAgent(ownerId: string, agentId: string): Promise<boolean>;
  now?: () => Date;
}) {
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  async function requireActiveBinding(db: BotExecutor, ownerId: string, agentId: string) {
    if (!ChatAgentIdSchema.safeParse(agentId).success) throw new BotResourceGrantError("missing");
    const chatTx = db as unknown as Transaction<ChatDatabase>;
    const owner = { type: "personal" as const, ownerId };
    // Agent file edits take this same lock. Never hold it during provider discovery.
    await lockChatAgentOwner(chatTx, owner);
    if (!await deps.isActiveManagedAgent(ownerId, agentId)) throw new BotResourceGrantError("missing");
    const binding = await requireBinding(db, ownerId, agentId);
    if (!await privateBotSourceChat(chatTx, owner, binding.chatId)) throw new BotResourceGrantError("missing");
    return binding;
  }
  const bindingFor = (ownerId: string, agentId: string) =>
    deps.transact(ownerId, (tx) => requireActiveBinding(tx.db, ownerId, agentId));

  async function discovered(target: BotResourceGrantTarget) {
    const { ownerId, agentId, chatId } = target;
    const candidates = await deps.providers.list({ ownerId, agentId, chatId });
    return ResourceProviderCandidateSchema.array().max(32).parse(candidates);
  }

  return {
    async list(ownerId: string, agentId: string) {
      const binding = await bindingFor(ownerId, agentId);
      const candidates = await discovered(binding);
      return deps.transact(ownerId, async (tx) => {
        const current = await requireActiveBinding(tx.db, ownerId, agentId);
        if (current.chatId !== binding.chatId || current.bindingCreatedAt !== binding.bindingCreatedAt) {
          throw new BotResourceGrantError("conflict");
        }
        const rows = await createBotResourceGrantsRepository(tx.db, current).list();
        const granted = rows.filter((row) => currentGrant(row, current));
        return BotResourceGrantListSchema.parse({
          grants: granted.map(view),
          candidates: candidates.filter((candidate) => !granted.some((grant) => grant.kind === candidate.scope.kind))
            .map((candidate) => ({
              id: candidateId(current, candidate, toSafeInteger(rows.find((row) => row.kind === candidate.scope.kind)?.revision ?? 0)),
              kind: candidate.scope.kind,
              label: candidate.label,
            })),
        });
      });
    },

    async grant(ownerId: string, agentId: string, id: string) {
      if (!BotResourceGrantCandidateIdSchema.safeParse(id).success) throw new BotResourceGrantError("denied");
      const binding = await bindingFor(ownerId, agentId);
      const candidates = await discovered(binding);
      return deps.transact(ownerId, async (tx) => {
        const current = await requireActiveBinding(tx.db, ownerId, agentId);
        if (current.chatId !== binding.chatId || current.bindingCreatedAt !== binding.bindingCreatedAt) {
          throw new BotResourceGrantError("conflict");
        }
        const repository = createBotResourceGrantsRepository(tx.db, current);
        const rows = await repository.list();
        for (const candidate of candidates) {
          const previous = rows.find((row) => row.kind === candidate.scope.kind);
          if (previous && currentGrant(previous, current)) {
            if (previous.candidate_id === id && previous.connection_id === candidate.connectionId
              && JSON.stringify(ResourceProviderCandidateSchema.shape.scope.parse(previous.scope)) === JSON.stringify(candidate.scope)) {
              return BotResourceGrantCreateResponseSchema.parse({ grant: view(previous) });
            }
            continue;
          }
          if (id !== candidateId(current, candidate, toSafeInteger(previous?.revision ?? 0))) continue;
          const saved = await repository.save({ id: `rgr_${randomUUID().replaceAll("-", "")}`, candidateId: id, candidate, now: now(), previous });
          if (saved) {
            const grant = view(saved);
            await tx.publish(current.chatId, "bot.authority.changed", { agentId, revision: grant.revision });
            return BotResourceGrantCreateResponseSchema.parse({ grant });
          }
          const concurrent = await repository.findActive(candidate.scope.kind);
          if (concurrent?.candidate_id === id) return BotResourceGrantCreateResponseSchema.parse({ grant: view(concurrent) });
          throw new BotResourceGrantError("conflict");
        }
        throw new BotResourceGrantError("denied");
      });
    },

    async revoke(ownerId: string, agentId: string, id: string, revision: number) {
      if (!BotResourceGrantIdSchema.safeParse(id).success || !BotRevisionSchema.safeParse(revision).success) {
        throw new BotResourceGrantError("missing");
      }
      return deps.transact(ownerId, async (tx) => {
        const binding = await requireBinding(tx.db, ownerId, agentId);
        const repository = createBotResourceGrantsRepository(tx.db, binding);
        const current = (await repository.list()).find((row) => row.grant_id === id && currentGrant(row, binding));
        if (!current) throw new BotResourceGrantError("missing");
        const revokedAt = now();
        const revoked = await repository.revoke(id, revision, revokedAt);
        if (!revoked) throw new BotResourceGrantError("conflict");
        await tx.publish(binding.chatId, "bot.authority.changed", { agentId, revision: toSafeInteger(revoked.revision) });
        return BotResourceGrantRevokeResponseSchema.parse({ grantId: id, revokedAt });
      });
    },
  };
}

export type BotResourceGrantService = ReturnType<typeof createBotResourceGrantService>;
