import { Kysely, PostgresDialect, sql, type Generated } from 'kysely';
import pg from 'pg';

interface ApiUsageTable {
  id: Generated<number>;
  timestamp: Generated<Date>;
  user_id: string;
  model: string;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  cache_read_tokens: Generated<number>;
  cache_write_tokens: Generated<number>;
  cost_usd: Generated<number>;
  session_id: string | null;
  status: Generated<number>;
}

interface UserQuotasTable {
  user_id: string;
  daily_limit_usd: number | null;
  monthly_limit_usd: number | null;
  enabled: Generated<boolean>;
}

interface ProxyDatabase {
  api_usage: ApiUsageTable;
  user_quotas: UserQuotasTable;
}

export interface UsageRecord {
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  sessionId?: string;
  status: number;
}

export interface QuotaCheck {
  allowed: boolean;
  dailyUsed: number;
  dailyLimit: number | null;
  monthlyUsed: number;
  monthlyLimit: number | null;
}

export interface ProxyDB {
  ready: Promise<void>;
  insertUsage(record: UsageRecord): Promise<void>;
  checkQuota(userId: string): Promise<QuotaCheck>;
  setQuota(userId: string, dailyLimitUsd: number | null, monthlyLimitUsd: number | null): Promise<void>;
  getUserUsage(userId: string): Promise<{ daily: number; monthly: number; total: number }>;
  getUsageSummary(): Promise<Array<{ userId: string; daily: number; monthly: number; total: number }>>;
  getMetricsSeed(): Promise<Array<{ user_id: string; model: string; cost: number; calls: number }>>;
  destroy(): Promise<void>;
}

const DEFAULT_PROXY_DB_URL =
  process.env.PROXY_DATABASE_URL ??
  process.env.PLATFORM_DATABASE_URL ??
  (process.env.POSTGRES_URL ? `${process.env.POSTGRES_URL}/matrixos_platform` : undefined);

export function createProxyDb(opts: string | { dialect: unknown } = DEFAULT_PROXY_DB_URL ?? ''): ProxyDB {
  if (typeof opts === 'string' && !opts) {
    throw new Error('Proxy Postgres URL is required: set PROXY_DATABASE_URL or PLATFORM_DATABASE_URL');
  }

  let pool: pg.Pool | null = null;
  const kysely: Kysely<ProxyDatabase> = typeof opts === 'string'
    ? (() => {
        pool = new pg.Pool({ connectionString: opts, max: 10 });
        pool.on('error', (err) => {
          console.error('[proxy-db] Idle pool client error:', err.message);
        });
        return new Kysely<ProxyDatabase>({ dialect: new PostgresDialect({ pool }) });
      })()
    : new Kysely<ProxyDatabase>({ dialect: opts.dialect as never });

  const ready = migrate(kysely);

  return {
    ready,
    async insertUsage(record) {
      await ready;
      await kysely
        .insertInto('api_usage')
        .values({
          user_id: record.userId,
          model: record.model,
          input_tokens: record.inputTokens,
          output_tokens: record.outputTokens,
          cache_read_tokens: record.cacheReadTokens,
          cache_write_tokens: record.cacheWriteTokens,
          cost_usd: record.costUsd,
          session_id: record.sessionId ?? null,
          status: record.status,
        })
        .execute();
    },
    async checkQuota(userId) {
      await ready;
      const quota = await kysely
        .selectFrom('user_quotas')
        .select(['daily_limit_usd', 'monthly_limit_usd', 'enabled'])
        .where('user_id', '=', userId)
        .executeTakeFirst();

      if (!quota || !quota.enabled) {
        return { allowed: true, dailyUsed: 0, dailyLimit: null, monthlyUsed: 0, monthlyLimit: null };
      }

      const dailyUsed = await sumCost(kysely, userId, 'day');
      const monthlyUsed = await sumCost(kysely, userId, 'month');

      const allowed =
        (quota.daily_limit_usd === null || dailyUsed < quota.daily_limit_usd) &&
        (quota.monthly_limit_usd === null || monthlyUsed < quota.monthly_limit_usd);

      return {
        allowed,
        dailyUsed,
        dailyLimit: quota.daily_limit_usd,
        monthlyUsed,
        monthlyLimit: quota.monthly_limit_usd,
      };
    },
    async setQuota(userId, dailyLimitUsd, monthlyLimitUsd) {
      await ready;
      await kysely
        .insertInto('user_quotas')
        .values({
          user_id: userId,
          daily_limit_usd: dailyLimitUsd,
          monthly_limit_usd: monthlyLimitUsd,
          enabled: true,
        })
        .onConflict((oc) =>
          oc.column('user_id').doUpdateSet({
            daily_limit_usd: dailyLimitUsd,
            monthly_limit_usd: monthlyLimitUsd,
          }),
        )
        .execute();
    },
    async getUserUsage(userId) {
      await ready;
      const [daily, monthly, total] = await Promise.all([
        sumCost(kysely, userId, 'day'),
        sumCost(kysely, userId, 'month'),
        sumCost(kysely, userId, 'all'),
      ]);
      return { daily, monthly, total };
    },
    async getUsageSummary() {
      await ready;
      const users = await kysely
        .selectFrom('api_usage')
        .select('user_id')
        .distinct()
        .execute();
      return Promise.all(
        users.map(async (u) => ({
          userId: u.user_id,
          ...(await this.getUserUsage(u.user_id)),
        })),
      );
    },
    async getMetricsSeed() {
      await ready;
      const rows = await kysely
        .selectFrom('api_usage')
        .select((eb) => [
          'user_id',
          'model',
          eb.fn.sum<number>('cost_usd').as('cost'),
          eb.fn.countAll<number>().as('calls'),
        ])
        .groupBy(['user_id', 'model'])
        .execute();
      return rows.map((r) => ({
        user_id: r.user_id,
        model: r.model,
        cost: Number(r.cost),
        calls: Number(r.calls),
      }));
    },
    async destroy() {
      // Kysely's PostgresDialect ends the pg.Pool on destroy(); calling
      // pool.end() again would throw "Called end on pool more than once".
      await kysely.destroy();
    },
  };
}

async function sumCost(
  kysely: Kysely<ProxyDatabase>,
  userId: string,
  window: 'day' | 'month' | 'all',
): Promise<number> {
  // Day/month boundaries follow the Postgres session timezone (UTC in our
  // Docker/server defaults). Quotas reset at midnight in that zone, not the
  // user's local TZ.
  let query = kysely
    .selectFrom('api_usage')
    .select((eb) => eb.fn.sum<number>('cost_usd').as('total'))
    .where('user_id', '=', userId);

  if (window === 'day') {
    query = query.where('timestamp', '>=', sql<Date>`current_date`);
  } else if (window === 'month') {
    query = query.where('timestamp', '>=', sql<Date>`date_trunc('month', current_date)`);
  }

  const row = await query.executeTakeFirst();
  return Number(row?.total ?? 0);
}

async function migrate(db: Kysely<ProxyDatabase>): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS api_usage (
      id BIGSERIAL PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      cache_read_tokens BIGINT NOT NULL DEFAULT 0,
      cache_write_tokens BIGINT NOT NULL DEFAULT 0,
      cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
      session_id TEXT,
      status INTEGER NOT NULL DEFAULT 200
    )
  `.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_usage_user ON api_usage(user_id)`.execute(db);
  await sql`CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON api_usage(timestamp)`.execute(db);

  await sql`
    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      daily_limit_usd DOUBLE PRECISION,
      monthly_limit_usd DOUBLE PRECISION,
      enabled BOOLEAN NOT NULL DEFAULT TRUE
    )
  `.execute(db);
}

let singleton: ProxyDB | undefined;

export function getProxyDb(): ProxyDB {
  if (!singleton) singleton = createProxyDb();
  return singleton;
}

export async function resetProxyDb(): Promise<void> {
  if (singleton) {
    await singleton.destroy();
    singleton = undefined;
  }
}

// Convenience re-exports for callers that don't manage the singleton themselves.
export const insertUsage = (record: UsageRecord) => getProxyDb().insertUsage(record);
export const checkQuota = (userId: string) => getProxyDb().checkQuota(userId);
export const setQuota = (userId: string, daily: number | null, monthly: number | null) =>
  getProxyDb().setQuota(userId, daily, monthly);
export const getUserUsage = (userId: string) => getProxyDb().getUserUsage(userId);
export const getUsageSummary = () => getProxyDb().getUsageSummary();
export const getMetricsSeed = () => getProxyDb().getMetricsSeed();
