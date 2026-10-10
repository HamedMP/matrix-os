import { createHash } from "node:crypto";
import { sql } from "kysely";
import { IsolatedChatEnvelopeSchema, isolatedChatModelMatches, type IsolatedChatEnvelope, type BotRecipeRef, type IsolatedBotTurnSchema } from "@matrix-os/contracts";
import type { z } from "zod/v4";
import { withTransaction, type BotExecutor } from "../bots/repositories/shared.js";
import { isManagedPiBinding, type BotRuntimeBinding, type PiRuntimeBinding } from "../bots/runtime-registry.js";

export interface IsolatedChatIdentity { ownerId: string; machineId: string; runtimeSlot: string; credentialSha256: string; sourceSha: string; runtimeTokenEpoch?: number }
export interface IsolatedChatAuthority {
  select(input: { ownerId: string; chatId: string; modelId: string }): boolean;
  selectCanonical?(input: { ownerId: string; chatId: string; botId: string; recipeRef: BotRecipeRef; modelId?: string }): IsolatedChatEnvelope["modelId"] | undefined;
  claim(binding: PiRuntimeBinding): Promise<z.infer<typeof IsolatedBotTurnSchema> | undefined>;
  targets(binding: PiRuntimeBinding): boolean;
  validate?(binding: PiRuntimeBinding): Promise<boolean>;
  consume(binding: PiRuntimeBinding): Promise<boolean>;
}

/** Trusted composition, not a client option or a home-directory profile. Durable
 * state belongs to owner Postgres; uncertain consumption is never released. */
export function createIsolatedChatAuthority(input: {
  config: IsolatedChatEnvelope; db: BotExecutor; identity(): IsolatedChatIdentity; now?: () => Date;
  verifyCanonical?(binding: BotRuntimeBinding): Promise<boolean>;
}): IsolatedChatAuthority {
  const config = IsolatedChatEnvelopeSchema.parse(input.config);
  const fingerprint = createHash("sha256").update(JSON.stringify(config)).digest("hex");
  const canonical = config.target?.kind === "canonical_bot" ? config.target : undefined;
  const now = input.now ?? (() => new Date());
  function valid(): boolean {
    const actual = input.identity(), at = now().getTime();
    return actual.ownerId === config.ownerId && actual.machineId === config.machineId
      && actual.runtimeSlot === config.runtimeSlot && actual.sourceSha === config.sourceSha
      && actual.credentialSha256 === config.runtimeCredentialSha256
      && (!canonical || actual.runtimeTokenEpoch === config.runtimeTokenEpoch)
      && Date.parse(config.startsAt) <= at && at < Date.parse(config.expiresAt);
  }
  const targets = (binding: PiRuntimeBinding) => (canonical ? !isManagedPiBinding(binding) : isManagedPiBinding(binding))
    && binding.ownerId === config.ownerId && binding.chatId === config.chatId;
  function canonicalBinding(binding: PiRuntimeBinding): binding is BotRuntimeBinding {
    if (!canonical) return false;
    return !isManagedPiBinding(binding) && binding.botId === canonical.botId
      && binding.recipeRef?.recipeId === canonical.recipeRef.recipeId && binding.recipeRef.version === canonical.recipeRef.version
      && binding.capabilities.length === 0 && binding.requestClass === "interactive" && !binding.subscription && !binding.anthropicApi;
  }
  async function definitionValid(binding: PiRuntimeBinding): Promise<boolean> {
    return !canonical || canonicalBinding(binding) && Boolean(await input.verifyCanonical?.(binding));
  }
  function durableRun(binding: PiRuntimeBinding) {
    return canonical && !isManagedPiBinding(binding) ? sql`exists (
      select 1 from chat_runs r join chats c on c.id = r.chat_id
        join bot_chat_bindings b on b.chat_id = c.id
        join bot_tasks t on t.chat_id = c.id and t.run_id = r.id
      where r.id = ${binding.runId} and c.id = ${binding.chatId} and c.owner_id = ${binding.ownerId}
        and c.owner_type = 'personal' and c.lifecycle = 'active' and c.collaboration is null
        and r.driver_kind = 'matrix_bot' and r.instance_id = 'matrix_bot_default'
        and r.status in ('accepted', 'running') and r.attempt = 1 and r.created_at >= ${config.startsAt}::timestamptz
        and b.owner_id = ${binding.ownerId} and b.bot_id = ${binding.botId} and b.kind = 'direct' and b.removed_at is null
        and t.task_id = ${binding.taskId} and t.bot_id = ${binding.botId} and t.owner_id = ${binding.ownerId}
        and t.status = 'running' and t.parent_task_id is null)`
      : sql`exists (select 1 from chat_runs r join chats c on c.id = r.chat_id
        where r.id = ${binding.runId} and c.id = ${binding.chatId} and c.owner_id = ${binding.ownerId}
          and c.owner_type = 'personal' and c.lifecycle = 'active' and c.collaboration is null
          and r.driver_kind = 'matrix_pi' and r.instance_id = 'matrix_pi_default'
          and r.status in ('accepted', 'running') and r.attempt = 1
          and r.created_at >= ${config.startsAt}::timestamptz)`;
  }
  return {
    selectCanonical(candidate) {
      if (!canonical || candidate.ownerId !== config.ownerId || candidate.chatId !== config.chatId) return undefined;
      if (!valid() || candidate.botId !== canonical.botId || candidate.recipeRef.recipeId !== canonical.recipeRef.recipeId
        || candidate.recipeRef.version !== canonical.recipeRef.version || candidate.recipeRef.recipeId !== "matrix-bot"
        || candidate.modelId !== undefined && !isolatedChatModelMatches(config.modelId, candidate.modelId)) throw new Error("Isolated Chat unavailable");
      return config.modelId;
    },
    select(candidate) {
      if (candidate.ownerId !== config.ownerId || candidate.chatId !== config.chatId) return false;
      if (canonical || !valid() || !isolatedChatModelMatches(config.modelId, candidate.modelId)) throw new Error("Isolated Chat unavailable");
      return true;
    },
    targets,
    async claim(binding) {
      if (!targets(binding)) return undefined;
      if (!valid() || !await definitionValid(binding) || binding.accessSourceId !== "matrix_included" || !isolatedChatModelMatches(config.modelId, binding.route.modelId)
        || binding.route.maxOutputTokens !== 256) throw new Error("Isolated Chat unavailable");
      // One immutable first run per phase. Releasing a runtime and restarting
      // this service cannot rebind the phase or clear its dispatched flag.
      const accepted = await withTransaction(input.db, async trx => {
        await sql`set local statement_timeout = '1500ms'`.execute(trx);
        await sql`set local lock_timeout = '500ms'`.execute(trx);
        await sql`select pg_advisory_xact_lock(hashtextextended('isolated-chat-phase-admission', 0))`.execute(trx);
        const row = await sql<{ phase_id: string }>`insert into managed_pi_isolated_phases
          (phase_id, config_hash, owner_id, chat_id, run_id, runtime_handle, execution_generation, expires_at)
          select ${config.phaseId}, ${fingerprint}, ${binding.ownerId}, ${binding.chatId}, ${binding.runId},
            ${binding.runtimeHandle}, ${binding.executionGeneration}, ${config.expiresAt}::timestamptz
          where (select count(*) from managed_pi_isolated_phases) < 64
            and ${durableRun(binding)}
          on conflict (phase_id) do nothing returning phase_id`.execute(trx);
        return row.rows.length === 1;
      });
      if (!accepted || !valid() || !await definitionValid(binding)) throw new Error("Isolated Chat unavailable");
      return { phaseId: config.phaseId, maxInputBytes: 131072,
        ...(canonical && !isManagedPiBinding(binding) ? { target: { ...canonical, chatId: binding.chatId, taskId: binding.taskId, runId: binding.runId } } : {}) };
    },
    async validate(binding) {
      if (!canonical) return true;
      if (!targets(binding) || !valid() || !await definitionValid(binding) || binding.accessSourceId !== "matrix_included"
        || !isolatedChatModelMatches(config.modelId, binding.route.modelId) || binding.route.maxOutputTokens !== 256) return false;
      // A read-only preflight blocks stale/absent claims before credential work.
      // The atomic pre-send UPDATE remains the sole consumption authority.
      const row = await withTransaction(input.db, async trx => {
        await sql`set local statement_timeout = '1500ms'`.execute(trx);
        await sql`set local lock_timeout = '500ms'`.execute(trx);
        return sql<{ eligible: boolean }>`select exists (select 1 from managed_pi_isolated_phases
          where phase_id = ${config.phaseId} and config_hash = ${fingerprint}
            and owner_id = ${binding.ownerId} and chat_id = ${binding.chatId} and run_id = ${binding.runId}
            and runtime_handle = ${binding.runtimeHandle} and execution_generation = ${binding.executionGeneration}
            and dispatched = false and expires_at > ${now().toISOString()}::timestamptz
            and ${durableRun(binding)}) as eligible`.execute(trx);
      });
      return row.rows[0]?.eligible === true && valid() && await definitionValid(binding);
    },
    async consume(binding) {
      if (!targets(binding) || !valid() || !await definitionValid(binding) || binding.accessSourceId !== "matrix_included"
        || !isolatedChatModelMatches(config.modelId, binding.route.modelId) || binding.route.maxOutputTokens !== 256) return false;
      // Conditional UPDATE is the atomic reservation before outbound fetch.
      // No finally/cancel/recovery path refunds it, including an unknown send.
      const row = await withTransaction(input.db, async trx => {
        await sql`set local statement_timeout = '1500ms'`.execute(trx);
        await sql`set local lock_timeout = '500ms'`.execute(trx);
        return sql`update managed_pi_isolated_phases set dispatched = true
          where phase_id = ${config.phaseId} and config_hash = ${fingerprint}
            and owner_id = ${binding.ownerId} and chat_id = ${binding.chatId} and run_id = ${binding.runId}
            and runtime_handle = ${binding.runtimeHandle} and execution_generation = ${binding.executionGeneration}
            and ${canonical ? durableRun(binding) : sql`true`}
            and dispatched = false and expires_at > ${now().toISOString()}::timestamptz
          returning phase_id`.execute(trx);
      });
      return row.rows.length === 1 && valid();
    },
  };
}
