import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod/v4';
import type { ChatOwner } from '../../chat/records.js';
import type { GoogleModelHistory } from './model-history.js';
import { contextOpaque } from './contexts-contracts.js';

const Context = z.strictObject({ ownerId: contextOpaque, chatId: contextOpaque,
  revision: z.number().int().positive().max(2_147_483_647), retentionDeadline: z.iso.datetime(),
  availability: z.enum(['available', 'expired', 'purging', 'deleted']), sources: z.array(z.strictObject({
    originId: z.string().regex(/^[a-f0-9]{64}$/), googleAccountId: z.uuid(), consentId: contextOpaque,
    profileId: contextOpaque, profileRevision: z.number().int().positive().max(2_147_483_647),
    purposeId: contextOpaque, expiresAt: z.iso.datetime(), state: z.enum(['active', 'purging']),
  })).min(1).max(32).refine(values => new Set(values.map(value => value.originId)).size === values.length),
});
const Known = z.discriminatedUnion('classification', [z.strictObject({ classification: z.literal('ordinary') }),
  z.strictObject({ classification: z.literal('google'), googleContext: Context })]);
export class GoogleModelHistoryError extends Error {
  constructor() { super('Chat context unavailable'); this.name = 'GoogleModelHistoryError'; }
}
function deny(): never { throw new GoogleModelHistoryError(); }
type ModelHistoryInput<T> = { owner: ChatOwner; chatId: string; targetChatId?: string; adapter?: unknown;
  signal?: AbortSignal; read(): Promise<T> };

/** Model-only admission. Never wrap authenticated owner preview/export with this
 * gate. Birth classification comes from a trusted server-create transaction, not
 * missing markers, timestamps, text scans or caller assertions. References inherit
 * lineage before loading text; own Google history requires the actual installed
 * broker adapter. Current provider/profile consent is still checked at dispatch.
 * The host supplies owner-scoped bounded read operations; no content is retained. */
export function createGoogleModelHistoryAdmission(options: {
  store: {
    inspect(owner: ChatOwner, chatId: string): Promise<GoogleModelHistory>;
    inherit(owner: ChatOwner, targetChatId: string, sourceIds: string[], expectedRevision?: number): Promise<GoogleModelHistory>;
  };
  isGuardedAdapter(adapter: unknown): boolean;
  now?: () => Date;
}) {
  if (![options.store?.inspect, options.store?.inherit, options.isGuardedAdapter].every(value => typeof value === 'function')) deny();
  const now = options.now ?? (() => new Date());
    async function prepareRead<T>(input: ModelHistoryInput<T>): Promise<{ value: T; assertCurrent(): void }> {
      try {
        const owner = structuredClone(input.owner);
        const adapter = input.adapter; const read = input.read;
        if (owner.type !== 'personal' || !contextOpaque.safeParse(owner.ownerId).success) deny();
        const chatId = contextOpaque.parse(input.chatId);
        const targetId = input.targetChatId === undefined ? undefined : contextOpaque.parse(input.targetChatId);
        const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(input.signal ? [input.signal] : [])]);
        const current = () => { if (signal.aborted) deny(); };
        async function checked<R>(work: () => Promise<R>): Promise<R> {
          current(); let stop!: () => void;
          const aborted = new Promise<never>((_resolve, reject) => { stop = () => reject(new GoogleModelHistoryError()); signal.addEventListener('abort', stop, { once: true }); });
          try { const value = await Promise.race([Promise.resolve().then(() => { current(); return work(); }), aborted]); current(); return value; }
          finally { signal.removeEventListener('abort', stop); }
        }
        function valid(value: unknown, id: string) {
          const history = Known.parse(value); const at = now().getTime();
          if (!Number.isSafeInteger(at) || at < 0) deny();
          if (history.classification === 'google') {
            const context = history.googleContext;
            if (context.ownerId !== owner.ownerId || context.chatId !== id || context.availability !== 'available'
              || Date.parse(context.retentionDeadline) <= at || context.sources.some(source => source.state !== 'active' || Date.parse(source.expiresAt) <= at)) deny();
          }
          return history;
        }
        const inspect = async (id: string) => valid(await checked(() => options.store.inspect(owner, id)), id);
        const source = await inspect(chatId);
        let target = targetId && targetId !== chatId ? await inspect(targetId) : undefined;
        if (targetId && targetId !== chatId) {
          const priorTarget = target;
          target = valid(await checked(() => options.store.inherit(owner, targetId, [chatId],
            target?.classification === 'google' ? target.googleContext.revision : undefined)), targetId);
          // A stale, malformed or substituted inheritance result cannot bless a read.
          if (source.classification === 'google') {
            if (target.classification !== 'google') deny();
            const inherited = target.googleContext;
            if (source.googleContext.sources.some(origin => !inherited.sources.some(value => isDeepStrictEqual(value, origin)))
              || Date.parse(inherited.retentionDeadline) > Date.parse(source.googleContext.retentionDeadline)) deny();
          }
          if (priorTarget?.classification === 'google') {
            if (target.classification !== 'google') deny();
            const retained = target.googleContext;
            if (priorTarget.googleContext.sources.some(origin => !retained.sources.some(value => isDeepStrictEqual(value, origin)))
              || Date.parse(retained.retentionDeadline) > Date.parse(priorTarget.googleContext.retentionDeadline)) deny();
          }
        }
        if ((source.classification === 'google' || target?.classification === 'google') && (!targetId || targetId === chatId)
          && options.isGuardedAdapter(adapter) !== true) deny();
        if (adapter !== undefined && (source.classification === 'google' || target?.classification === 'google')
          && options.isGuardedAdapter(adapter) !== true) deny();
        const value = await checked(read);
        const after = await inspect(chatId);
        if (!isDeepStrictEqual(source, after)) deny();
        if (target && !isDeepStrictEqual(target, await inspect(targetId!))) deny();
        // Clocks can cross retention while the final classification query is queued.
        const assertCurrent = () => {
          try { valid(after, chatId); if (target) valid(target, targetId!); current(); }
          catch (error: unknown) {
            if (error instanceof GoogleModelHistoryError) throw error;
            throw new GoogleModelHistoryError();
          }
        };
        assertCurrent(); return { value, assertCurrent };
      } catch (error: unknown) {
        if (error instanceof GoogleModelHistoryError) throw error;
        throw new GoogleModelHistoryError();
      }
    }
  return { prepareRead, async read<T>(input: ModelHistoryInput<T>): Promise<T> {
    const prepared = await prepareRead(input); prepared.assertCurrent(); return prepared.value;
  } };
}
