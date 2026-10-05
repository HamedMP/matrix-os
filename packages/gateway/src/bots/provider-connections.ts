import { sql } from 'kysely';
import { BotExecutionBindingSchema, BotExecutionBindingRequestSchema, BotProviderAuthorizationRequestSchema, BotProviderConnectionsSchema,
  type BotExecutionBinding, type BotProviderConnections, type BotProviderConnection } from '@matrix-os/contracts';
import type { BotExecutor } from './repositories/shared.js';
import { withTransaction } from './repositories/shared.js';

export type ClaudeTaskObservation = { available: false; reason: 'authentication_required' | 'unsupported_runtime' } | {
  available: true; fingerprint: string; models: BotProviderConnection['models'];
};
export class BotProviderConnectionError extends Error {
  constructor(readonly code: 'forbidden' | 'invalid_request' | 'unavailable' | 'conflict' | 'not_found') { super(code); }
}
const empty: BotExecutionBinding = { revision: 0, connectionId: null, model: null, grantRevision: null };
/** Nonsecret consent/configuration lives in the owner's existing Postgres. Native tokens never enter it. */
export function createBotProviderConnections(deps: {
  db: BotExecutor; ownerId: string; computerId: string;
  agentExists(ownerId: string, botId: string): Promise<boolean>;
  observeClaude(): Promise<ClaudeTaskObservation>;
}) {
  const scope = (owner: string) => {
    if (!deps.ownerId || !deps.computerId) throw new BotProviderConnectionError('unavailable');
    if (owner !== deps.ownerId) throw new BotProviderConnectionError('forbidden');
  };
  async function grant(db: BotExecutor = deps.db) {
    return db.selectFrom('bot_provider_authorizations').selectAll().where('owner_id', '=', deps.ownerId)
      .where('computer_id', '=', deps.computerId).where('connection_id', '=', 'claude_code_tasks').executeTakeFirst();
  }
  async function row(botId: string, db: BotExecutor = deps.db) {
    return db.selectFrom('bot_execution_bindings').selectAll().where('owner_id', '=', deps.ownerId)
      .where('computer_id', '=', deps.computerId).where('bot_id', '=', botId).executeTakeFirst();
  }
  const project = (saved: Awaited<ReturnType<typeof row>>): BotExecutionBinding => saved ? BotExecutionBindingSchema.parse({
    revision: Number(saved.revision), connectionId: saved.connection_id, model: saved.model,
    grantRevision: saved.grant_revision === null ? null : Number(saved.grant_revision),
  }) : { ...empty };
  async function ownBot(owner: string, botId: string) {
    scope(owner);
    if (!await deps.agentExists(owner, botId)) throw new BotProviderConnectionError('not_found');
  }
  // A bounded owner/Computer lock makes first-row creation and consent/config writes atomic.
  async function lock(db: BotExecutor) {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`bot-provider:${deps.ownerId}:${deps.computerId}`}, 0))`.execute(db);
  }
  const service = {
    async connections(owner: string): Promise<BotProviderConnections> {
      scope(owner);
      const [observed, saved] = await Promise.all([deps.observeClaude(), grant()]);
      const enabled = Boolean(saved?.enabled && observed.available && saved.fingerprint === observed.fingerprint);
      return BotProviderConnectionsSchema.parse({ connections: [
        { id: 'matrix_chatgpt_plan', providerId: 'openai', executionKind: 'direct_pi', availability: 'unavailable', unavailableReason: 'provider_access_required',
          models: [], authorization: { revision: 0, enabled: false, background: false }, coordinatorFunding: 'separate' },
        { id: 'claude_code_tasks', providerId: 'anthropic', executionKind: 'native_task',
          availability: !observed.available ? 'unavailable' : enabled ? 'available' : 'setup_required',
          ...(!observed.available ? { unavailableReason: observed.reason } : !enabled ? { unavailableReason: 'authorization_required' } : {}),
          models: observed.available ? observed.models : [], authorization: { revision: Number(saved?.revision ?? 0), enabled, background: enabled && Boolean(saved?.background) }, coordinatorFunding: 'separate' },
      ] });
    },
    async authorize(owner: string, connectionId: string, input: unknown): Promise<BotProviderConnections> {
      scope(owner);
      const parsed = BotProviderAuthorizationRequestSchema.safeParse(input);
      if (!parsed.success) throw new BotProviderConnectionError('invalid_request');
      if (connectionId !== 'claude_code_tasks') throw new BotProviderConnectionError('unavailable');
      const observed = await deps.observeClaude();
      if (parsed.data.enabled && !observed.available) throw new BotProviderConnectionError('unavailable');
      await withTransaction(deps.db, async tx => {
        await lock(tx); const saved = await grant(tx);
        if (Number(saved?.revision ?? 0) !== parsed.data.baseRevision) throw new BotProviderConnectionError('conflict');
        const values = { fingerprint: observed.available ? observed.fingerprint : saved?.fingerprint ?? '', enabled: parsed.data.enabled,
          background: parsed.data.enabled && parsed.data.background, revision: parsed.data.baseRevision + 1 };
        if (saved) {
          const updated = await tx.updateTable('bot_provider_authorizations').set(values).where('owner_id', '=', owner).where('computer_id', '=', deps.computerId)
            .where('connection_id', '=', connectionId).where('revision', '=', parsed.data.baseRevision).returning('revision').executeTakeFirst();
          if (!updated) throw new BotProviderConnectionError('conflict');
        } else {
          const inserted = await tx.insertInto('bot_provider_authorizations').values({ owner_id: owner, computer_id: deps.computerId, connection_id: connectionId, ...values })
            .onConflict(conflict => conflict.columns(['owner_id', 'computer_id', 'connection_id']).doNothing()).returning('revision').executeTakeFirst();
          if (!inserted) throw new BotProviderConnectionError('conflict');
        }
      });
      return service.connections(owner);
    },
    async execution(owner: string, botId: string): Promise<BotExecutionBinding> {
      await ownBot(owner, botId); return project(await row(botId));
    },
    async configure(owner: string, botId: string, input: unknown): Promise<BotExecutionBinding> {
      await ownBot(owner, botId);
      const parsed = BotExecutionBindingRequestSchema.safeParse(input);
      if (!parsed.success) throw new BotProviderConnectionError('invalid_request');
      const observed = await deps.observeClaude();
      return withTransaction(deps.db, async tx => {
        await lock(tx); const saved = await row(botId, tx); const consent = await grant(tx);
        if (Number(saved?.revision ?? 0) !== parsed.data.baseRevision) throw new BotProviderConnectionError('conflict');
        if (parsed.data.connectionId && (!observed.available || !consent?.enabled || consent.fingerprint !== observed.fingerprint
          || !observed.models.some(model => model.id === parsed.data.model))) throw new BotProviderConnectionError('unavailable');
        const values = { connection_id: parsed.data.connectionId, model: parsed.data.model ?? null,
          grant_revision: parsed.data.connectionId ? Number(consent!.revision) : null, native_session_id: null, revision: parsed.data.baseRevision + 1 };
        if (saved) {
          const updated = await tx.updateTable('bot_execution_bindings').set(values).where('owner_id', '=', owner).where('computer_id', '=', deps.computerId)
            .where('bot_id', '=', botId).where('revision', '=', parsed.data.baseRevision).returningAll().executeTakeFirst();
          if (!updated) throw new BotProviderConnectionError('conflict'); return project(updated);
        }
        const inserted = await tx.insertInto('bot_execution_bindings').values({ owner_id: owner, computer_id: deps.computerId, bot_id: botId, ...values })
          .onConflict(conflict => conflict.columns(['owner_id', 'computer_id', 'bot_id']).doNothing()).returningAll().executeTakeFirst();
        if (!inserted) throw new BotProviderConnectionError('conflict'); return project(inserted);
      });
    },
    async admit(owner: string, botId: string, requestClass: 'interactive' | 'background') {
      await ownBot(owner, botId);
      const [selected, consent, observed] = await Promise.all([row(botId), grant(), deps.observeClaude()]);
      if (!selected?.connection_id || !consent?.enabled || !observed.available || consent.fingerprint !== observed.fingerprint
        || Number(selected.grant_revision) !== Number(consent.revision) || !observed.models.some(model => model.id === selected.model)) throw new BotProviderConnectionError('unavailable');
      if (requestClass === 'background' && !consent.background) throw new BotProviderConnectionError('forbidden');
      return { model: selected.model!, revision: Number(selected.revision), grantRevision: Number(consent.revision), sessionId: selected.native_session_id };
    },
    async saveSession(owner: string, botId: string, revision: number, sessionId: string): Promise<void> {
      scope(owner);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new BotProviderConnectionError('unavailable');
      const changed = await deps.db.updateTable('bot_execution_bindings').set({ native_session_id: sessionId }).where('owner_id', '=', owner)
        .where('computer_id', '=', deps.computerId).where('bot_id', '=', botId).where('revision', '=', revision).returning('revision').executeTakeFirst();
      if (!changed) throw new BotProviderConnectionError('conflict');
    },
  };
  return service;
}
export type BotProviderConnectionsService = ReturnType<typeof createBotProviderConnections>;
