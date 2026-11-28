import { sql } from 'kysely';
import { ChatRepository } from '../../chat/repository.js';
import type { ChatDatabase } from '../../chat/database.js';
import type { ChatOwner } from '../../chat/records.js';
import { boundedProvenanceTransaction } from '../provenance/transaction.js';
import { createGoogleModelHistoryAdmission, GoogleModelHistoryError } from './model-history-admission.js';
import { createGoogleModelHistoryStore } from './model-history.js';

export interface GoogleModelHistoryRead {
  owner: ChatOwner;
  chatId: string;
  targetChatId?: string;
  adapter?: unknown;
  signal?: AbortSignal;
}
export interface GoogleModelHistoryReader {
  read<T>(input: GoogleModelHistoryRead & { read(repository: ChatRepository, signal: AbortSignal): Promise<T> }): Promise<T>;
  assertRun(input: GoogleModelHistoryRead & { adapter: unknown }): Promise<void>;
}

/** Private model-only composition. The read callback must use the supplied repository:
 * classification, reference inheritance and content loading share one transaction and
 * the context/purge advisory lock. A caller transaction retains that lock until commit.
 * Callbacks must be finite database reads using this repository, not external calls
 * or unbounded waits. Pending/queued queries drain before the transaction releases.
 * Owner inspection/export must continue using the ordinary authenticated repository.
 * This is not provider approval: dispatch still needs current broker/recipient consent.
 * Migrate the history store before installation; never bless legacy rows by backfill. */
export function createGoogleModelHistoryReader(options: {
  repository: ChatRepository;
  isGuardedAdapter(adapter: unknown): boolean;
  now?: () => Date;
}): GoogleModelHistoryReader {
  const repository = options.repository;
  const isGuardedAdapter = options.isGuardedAdapter;
  const clock = options.now;
  async function read<T>(input: GoogleModelHistoryRead & { read(repository: ChatRepository, signal: AbortSignal): Promise<T> }): Promise<T> {
    try {
      const signal = AbortSignal.any([AbortSignal.timeout(10000), ...(input.signal ? [input.signal] : [])]);
      const subject = { owner: structuredClone(input.owner), chatId: input.chatId,
        ...(input.targetChatId !== undefined ? { targetChatId: input.targetChatId } : {}),
        ...(input.adapter !== undefined ? { adapter: input.adapter } : {}),
        signal,
      };
      const load = input.read;
      if (subject.signal?.aborted) throw new GoogleModelHistoryError();
      const prepared = await repository.withTransaction(scoped => boundedProvenanceTransaction(scoped.kysely, async tx => {
        let closed = false;
        const checkRead = () => { if (closed || signal.aborted) throw new GoogleModelHistoryError(); };
        // This wrapper owns no pool. Guard both compilation and result delivery;
        // callbacks cannot start later repository queries after their scope closes.
        const readRepository = new ChatRepository(tx.withPlugin({
          transformQuery: args => { checkRead(); return args.node; },
          transformResult: async args => { checkRead(); return args.result; },
        }), true);
        const admission = createGoogleModelHistoryAdmission({
          store: createGoogleModelHistoryStore<ChatDatabase>(tx, clock ? { now: clock } : {}), isGuardedAdapter,
          ...(clock ? { now: clock } : {}),
        });
        let loading: Promise<T> | undefined;
        try {
          return await admission.prepareRead({ ...subject, read: () => {
            loading = Promise.resolve().then(() => load(readRepository, signal)); return loading;
          } });
        } finally {
          // Cancellation may win the admission race while SQL is already queued on
          // the single transaction connection. Drain the entire trusted callback
          // before COMMIT/ROLLBACK can release that connection or its purge fence.
          closed = true;
          try {
            if (loading) {
              await loading.then(() => undefined, (error: unknown) => {
                console.warn('[google-history] Read callback failed:', error instanceof Error ? error.name : 'NonError');
              });
              // Promise.all can reject while sibling queries are still queued.
              // Original transaction executor shares the same single-connection
              // provider: this final barrier settles after those queued queries,
              // even when PostgreSQL rejects them in an aborted transaction.
              try { await sql`SELECT 1`.execute(tx); }
              catch (error: unknown) {
                console.warn('[google-history] Query drain failed:', error instanceof Error ? error.name : 'NonError');
                throw new GoogleModelHistoryError();
              }
            }
          } finally { await readRepository.release(); }
        }
      }));
      // COMMIT and repository post-commit work can themselves wait. Never release
      // content after cancellation or the captured retention deadline during that gap.
      prepared.assertCurrent();
      return prepared.value;
    } catch (error: unknown) {
      if (error instanceof GoogleModelHistoryError) throw error;
      throw new GoogleModelHistoryError();
    }
  }
  return { read, assertRun: input => read({ ...input, read: async () => undefined }) };
}
