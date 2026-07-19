import { Kysely, PostgresDialect, type Transaction } from 'kysely';
import pg from 'pg';
import { migrateAts, type AtsDatabaseTables } from './ats-schema.js';

type AtsExecutor = Kysely<AtsDatabaseTables> | Transaction<AtsDatabaseTables>;

export interface AtsDB {
  kysely: Kysely<AtsDatabaseTables>;
  executor: AtsExecutor;
  ready: Promise<void>;
  transaction<T>(fn: (trx: AtsDB) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

export class AtsDatabaseConfigError extends Error {
  constructor() {
    super('ATS_DATABASE_URL is required when recruiting ATS secrets are configured');
    this.name = 'AtsDatabaseConfigError';
  }
}

export function resolveAtsDatabaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const databaseUrl = env.ATS_DATABASE_URL?.trim() || undefined;
  const enabled = Boolean(env.ATS_INGEST_SECRET?.trim() || env.ATS_ADMIN_SECRET?.trim());
  if (enabled && !databaseUrl) throw new AtsDatabaseConfigError();
  return databaseUrl;
}

function wrapAtsDb(
  kysely: Kysely<AtsDatabaseTables>,
  executor: AtsExecutor,
  ready: Promise<void>,
  destroyFn: () => Promise<void>,
): AtsDB {
  return {
    kysely,
    executor,
    ready,
    async transaction(fn) {
      await ready;
      return kysely.transaction().execute((trx) =>
        fn(wrapAtsDb(kysely, trx, Promise.resolve(), destroyFn)),
      );
    },
    destroy: destroyFn,
  };
}

export function createAtsDb(opts: string | { dialect: unknown }): AtsDB {
  if (typeof opts === 'string' && !opts.trim()) throw new AtsDatabaseConfigError();
  let pool: pg.Pool | null = null;
  const kysely = typeof opts === 'string'
    ? (() => {
        pool = new pg.Pool({ connectionString: opts, max: 5 });
        pool.on('error', (err) => console.error('[ats-db] Idle pool client error:', err.message));
        return new Kysely<AtsDatabaseTables>({ dialect: new PostgresDialect({ pool }) });
      })()
    : new Kysely<AtsDatabaseTables>({ dialect: opts.dialect as never });
  const ready = migrateAts(kysely);
  return wrapAtsDb(kysely, kysely, ready, async () => {
    await kysely.destroy();
    try {
      await pool?.end();
    } catch (err: unknown) {
      if (!(err instanceof Error && err.message === 'Called end on pool more than once')) throw err;
    }
  });
}
