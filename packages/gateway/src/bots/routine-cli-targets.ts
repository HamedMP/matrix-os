import { sql, type Kysely, type Transaction } from "kysely";
import { z } from "zod/v4";
import {
  RoutineCliActionSchema, RoutineCliRememberTargetSchema, RoutineCliResetTargetSchema,
  RoutineCliTargetPreferenceSchema, type RoutineCliAction, type RoutineCliTargetPreference,
} from "@matrix-os/contracts";
import type { ChatDatabase } from "../chat/database.js";
import type { RequestPrincipal } from "../request-principal.js";
import { lockChatAgentOwner } from "../chat/agent-owner-lock.js";
import type { ChatAgentStore } from "../chat/agent-store.js";
import type { OwnerBotDatabase } from "./database.js";
import { RoutineCliError, routineCliBoundary } from "./routine-cli-errors.js";
import {
  createRoutineCliPreferencesRepository, lockRoutineCliPreference, RoutineCliScopeSchema,
  routineCliBindingTimestamp, type RoutineCliScope, type RoutineCliStoredPreference,
} from "./repositories/routine-cli-preferences.js";

import { RoutineCliSourceContextSchema as SourceContextSchema, type RoutineCliSourceContext } from "./routine-cli-source-context.js";
export type { RoutineCliSourceContext } from "./routine-cli-source-context.js";

/** Internal dispatch snapshot, never the general-purpose CLI DTO. */
export interface RoutineCliResolvedTarget extends RoutineCliScope {
  botId: string;
  chatId: string;
  bindingCreatedAt: string;
  preferenceRevision: number;
}
type TargetAccess = RoutineCliScope & { botId: string; chatId: string; action: RoutineCliAction | "remember" };
export interface RoutineCliTargetDependencies {
  db: Kysely<OwnerBotDatabase>;
  /** Configured/admitted current Computer and owner, not body or environment hints from a model. */
  scope: RoutineCliScope;
  agents: Pick<ChatAgentStore, "get">;
  now?: () => Date;
  /** Must check exact live native turn/session/launch + generation, private policy and current scopes.
   * Implementations must hold the same generation gate used by revoke/consume through this transaction.
   * A boolean fixture is not source admission or source-runtime integration. */
  revalidateSource?: (source: RoutineCliSourceContext, action: RoutineCliAction, executor: Transaction<OwnerBotDatabase>) => Promise<boolean>;
  /** Current owner access only; granting access here is explicitly forbidden. */
  canAccessTarget?: (target: TargetAccess, executor: Transaction<OwnerBotDatabase>) => Promise<boolean>;
}

export function createRoutineCliTargetService(deps: RoutineCliTargetDependencies) {
  const preferences = createRoutineCliPreferencesRepository(deps.db);
  const now = () => deps.now?.() ?? new Date();
  const scope = (): RoutineCliScope => {
    const parsed = RoutineCliScopeSchema.safeParse(deps.scope);
    if (!parsed.success || !deps.agents || typeof deps.agents.get !== "function") throw new RoutineCliError("unavailable");
    return parsed.data;
  };
  const requireOwner = (principal: RequestPrincipal): RoutineCliScope => {
    const configured = scope();
    const parsed = z.object({ userId: RoutineCliScopeSchema.shape.ownerId,
      source: z.enum(["jwt", "platform-verified", "configured-container", "dev-default"]) }).strict().safeParse(principal);
    if (!parsed.success || parsed.data.userId !== configured.ownerId) throw new RoutineCliError("permission_denied");
    return configured;
  };
  const project = (value: RoutineCliStoredPreference | null): RoutineCliTargetPreference => RoutineCliTargetPreferenceSchema.parse(
    value ?? { target: null, revision: 0, updatedAt: null });

  const validateTarget = async (trx: Transaction<OwnerBotDatabase>, configured: RoutineCliScope,
    target: { botId: string; chatId: string; bindingCreatedAt?: string }, action: TargetAccess["action"]) => {
    if (!deps.canAccessTarget) throw new RoutineCliError("unavailable");
    // Same lock as ChatAgentStore file updates; keep it through dispatch's write.
    await lockChatAgentOwner(trx as unknown as Transaction<ChatDatabase>, { type: "personal", ownerId: configured.ownerId });
    const definition = await deps.agents.get({ type: "personal", ownerId: configured.ownerId }, target.botId);
    if (!definition || definition.id !== target.botId || definition.archived || !definition.recipeRef)
      throw new RoutineCliError("target_unavailable");
    const chat = await trx.selectFrom("chats").select(["id", "owner_id", "owner_type", "collaboration", "lifecycle"])
      .where("id", "=", target.chatId).forUpdate().executeTakeFirst();
    if (!chat || chat.owner_id !== configured.ownerId || chat.owner_type !== "personal" || chat.collaboration !== null || chat.lifecycle !== "active")
      throw new RoutineCliError("target_unavailable");
    // Chat FOR UPDATE fences new FK inserts. Restoring an existing removed binding
    // changes no FK column, so lock those rows too before evaluating live membership.
    // Aggregate in Postgres to avoid returning unbounded historical rows to Node.
    await sql`WITH locked_bindings AS MATERIALIZED (
      SELECT 1 FROM bot_chat_bindings WHERE chat_id = ${target.chatId}
      ORDER BY owner_id, bot_id FOR UPDATE
    ) SELECT count(*) FROM locked_bindings`.execute(trx);
    // More than one live binding of any kind is ambiguous, even when a matching direct row exists.
    const bindings = await trx.selectFrom("bot_chat_bindings").select(["owner_id", "bot_id", "kind"])
      .select(sql<string>`created_at::text`.as("binding_timestamp"))
      .where("chat_id", "=", target.chatId).where("removed_at", "is", null).limit(2).forUpdate().execute();
    const binding = bindings[0];
    if (bindings.length !== 1 || !binding || binding.owner_id !== configured.ownerId || binding.bot_id !== target.botId || binding.kind !== "direct")
      throw new RoutineCliError("target_unavailable");
    const bindingCreatedAt = routineCliBindingTimestamp(binding.binding_timestamp);
    if (target.bindingCreatedAt !== undefined && bindingCreatedAt !== target.bindingCreatedAt)
      throw new RoutineCliError("target_unavailable");
    if (!await deps.canAccessTarget({ ...configured, botId: target.botId, chatId: target.chatId, action }, trx))
      throw new RoutineCliError("target_unavailable");
    return { botId: target.botId, chatId: target.chatId, bindingCreatedAt };
  };
  const requireSource = (value: RoutineCliSourceContext | undefined, action: RoutineCliAction): RoutineCliSourceContext => {
    if (!value) throw new RoutineCliError("source_context_required");
    const parsed = SourceContextSchema.safeParse(value);
    const configured = scope();
    if (!parsed.success || !RoutineCliActionSchema.safeParse(action).success) throw new RoutineCliError("permission_denied");
    const source = parsed.data, currentTime = now().getTime();
    if (!Number.isFinite(currentTime) || source.ownerId !== configured.ownerId || source.computerId !== configured.computerId
      || Date.parse(source.issuedAt) > currentTime || Date.parse(source.expiresAt) <= currentTime
      || Date.parse(source.expiresAt) <= Date.parse(source.issuedAt) || !source.actions.includes(action))
      throw new RoutineCliError("permission_denied");
    return source;
  };
  const sourceLive = async (trx: Transaction<OwnerBotDatabase>, source: RoutineCliSourceContext, action: RoutineCliAction) => {
    requireSource(source, action);
    if (!deps.revalidateSource) throw new RoutineCliError("unavailable");
    if (!await deps.revalidateSource(source, action, trx)) throw new RoutineCliError("permission_denied");
    requireSource(source, action);
  };
  const resolveWithin = (trx: Transaction<OwnerBotDatabase>, value: RoutineCliSourceContext | undefined,
    action: RoutineCliAction, pinned?: RoutineCliResolvedTarget): Promise<RoutineCliResolvedTarget> => routineCliBoundary(async () => {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    const source = requireSource(value, action), configured = scope();
    await sourceLive(trx, source, action);
    await lockRoutineCliPreference(trx, configured);
    const saved = await preferences.get(configured, trx);
    if (pinned && (pinned.ownerId !== configured.ownerId || pinned.computerId !== configured.computerId
      || pinned.preferenceRevision !== saved?.revision || pinned.botId !== saved?.target?.botId
      || pinned.chatId !== saved?.target?.chatId || pinned.bindingCreatedAt !== saved?.target?.bindingCreatedAt))
      throw new RoutineCliError("revision_conflict");
    if (!saved?.target) throw new RoutineCliError("target_required");
    const target = await validateTarget(trx, configured, saved.target, action);
    await sourceLive(trx, source, action);
    return { ...configured, ...target, preferenceRevision: saved.revision };
  });
  /** Already accepted receipt/task target; current default preference cannot redirect this snapshot. */
  const validatePinnedWithin = (trx: Transaction<OwnerBotDatabase>, value: RoutineCliSourceContext | undefined,
    action: RoutineCliAction, snapshot: RoutineCliResolvedTarget): Promise<RoutineCliResolvedTarget> => routineCliBoundary(async () => {
    if (!trx.isTransaction) throw new RoutineCliError("unavailable");
    const source = requireSource(value, action), configured = scope();
    const target = RoutineCliScopeSchema.extend({ botId: RoutineCliRememberTargetSchema.shape.botId,
      chatId: RoutineCliRememberTargetSchema.shape.chatId, bindingCreatedAt: z.iso.datetime({ offset: true }),
      preferenceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(snapshot);
    if (target.ownerId !== configured.ownerId || target.computerId !== configured.computerId) throw new RoutineCliError("permission_denied");
    await sourceLive(trx, source, action);
    const live = await validateTarget(trx, configured, target, action);
    await sourceLive(trx, source, action);
    return { ...configured, ...live, preferenceRevision: target.preferenceRevision };
  });
  return {
    validatePinnedWithin,
    /** Private accepted-task port: caller must prove the immutable task/run claim first. This validates
     * current owner/target policy only; it neither revives the origin nor authorizes an unclaimed intent. */
    validateClaimedTargetWithin: (trx: Transaction<OwnerBotDatabase>, snapshot: RoutineCliResolvedTarget): Promise<RoutineCliResolvedTarget> => routineCliBoundary(async () => {
      if (!trx.isTransaction) throw new RoutineCliError("unavailable");
      const configured = scope(), target = RoutineCliScopeSchema.extend({ botId: RoutineCliRememberTargetSchema.shape.botId,
        chatId: RoutineCliRememberTargetSchema.shape.chatId, bindingCreatedAt: z.iso.datetime({ offset: true }),
        preferenceRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().parse(snapshot);
      if (target.ownerId !== configured.ownerId || target.computerId !== configured.computerId) throw new RoutineCliError("permission_denied");
      const live = await validateTarget(trx, configured, target, "propose");
      return { ...configured, ...live, preferenceRevision: target.preferenceRevision };
    }),
    remember: (principal: RequestPrincipal, value: z.infer<typeof RoutineCliRememberTargetSchema>): Promise<RoutineCliTargetPreference> => routineCliBoundary(async () => {
      const configured = requireOwner(principal), input = RoutineCliRememberTargetSchema.parse(value);
      return deps.db.transaction().execute(async trx => {
        await lockRoutineCliPreference(trx, configured);
        const target = await validateTarget(trx, configured, input, "remember");
        return project(await preferences.save({ ...configured, target, baseRevision: input.baseRevision, now: now().toISOString() }, trx));
      });
    }),
    getDefault: (principal: RequestPrincipal): Promise<RoutineCliTargetPreference> => routineCliBoundary(async () => {
      const configured = requireOwner(principal);
      return deps.db.transaction().execute(async trx => {
        await lockRoutineCliPreference(trx, configured);
        const saved = await preferences.get(configured, trx);
        if (saved?.target) await validateTarget(trx, configured, saved.target, "read");
        return project(saved);
      });
    }),
    /** Owner-only stored navigation metadata for recovery; never proves live target/action access.
     * Task4 must use this read to recover an invalid default, then reset/reselect with revision CAS. */
    getStoredPreference: (principal: RequestPrincipal): Promise<RoutineCliTargetPreference> => routineCliBoundary(async () =>
      project(await preferences.get(requireOwner(principal)))),
    reset: (principal: RequestPrincipal, value: z.infer<typeof RoutineCliResetTargetSchema>): Promise<RoutineCliTargetPreference> => routineCliBoundary(async () => {
      const configured = requireOwner(principal), input = RoutineCliResetTargetSchema.parse(value);
      return project(await preferences.reset({ ...configured, ...input, now: now().toISOString() }));
    }),
    resolveWithin,
    resolve: (source: RoutineCliSourceContext | undefined, action: RoutineCliAction): Promise<RoutineCliResolvedTarget> =>
      routineCliBoundary(() => deps.db.transaction().execute(trx => resolveWithin(trx, source, action))),
  };
}
export type RoutineCliTargetService = ReturnType<typeof createRoutineCliTargetService>;
