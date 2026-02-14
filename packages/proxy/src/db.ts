import Database from 'better-sqlite3';

const DB_PATH = process.env.PROXY_DB_PATH ?? '/data/proxy.db';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      user_id TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      session_id TEXT,
      status INTEGER NOT NULL DEFAULT 200
    );

    CREATE INDEX IF NOT EXISTS idx_usage_user ON api_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_timestamp ON api_usage(timestamp);

    CREATE TABLE IF NOT EXISTS user_quotas (
      user_id TEXT PRIMARY KEY,
      daily_limit_usd REAL,
      monthly_limit_usd REAL,
      enabled INTEGER NOT NULL DEFAULT 1
    );
  `);
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

export function insertUsage(record: UsageRecord): void {
  const stmt = getDb().prepare(`
    INSERT INTO api_usage (user_id, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens, cost_usd, session_id, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    record.userId, record.model, record.inputTokens, record.outputTokens,
    record.cacheReadTokens, record.cacheWriteTokens, record.costUsd,
    record.sessionId ?? null, record.status
  );
}

export interface QuotaCheck {
  allowed: boolean;
  dailyUsed: number;
  dailyLimit: number | null;
  monthlyUsed: number;
  monthlyLimit: number | null;
}

export function checkQuota(userId: string): QuotaCheck {
  const db = getDb();

  const quota = db.prepare(
    'SELECT daily_limit_usd, monthly_limit_usd, enabled FROM user_quotas WHERE user_id = ?'
  ).get(userId) as { daily_limit_usd: number | null; monthly_limit_usd: number | null; enabled: number } | undefined;

  if (!quota || !quota.enabled) {
    return { allowed: true, dailyUsed: 0, dailyLimit: null, monthlyUsed: 0, monthlyLimit: null };
  }

  const dailyUsed = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE user_id = ? AND timestamp >= date('now')"
  ).get(userId) as { total: number }).total;

  const monthlyUsed = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE user_id = ? AND timestamp >= date('now', 'start of month')"
  ).get(userId) as { total: number }).total;

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
}

export function setQuota(userId: string, dailyLimitUsd: number | null, monthlyLimitUsd: number | null): void {
  getDb().prepare(`
    INSERT INTO user_quotas (user_id, daily_limit_usd, monthly_limit_usd)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET daily_limit_usd = ?, monthly_limit_usd = ?
  `).run(userId, dailyLimitUsd, monthlyLimitUsd, dailyLimitUsd, monthlyLimitUsd);
}

export function getUserUsage(userId: string): { daily: number; monthly: number; total: number } {
  const db = getDb();

  const daily = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE user_id = ? AND timestamp >= date('now')"
  ).get(userId) as { total: number }).total;

  const monthly = (db.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE user_id = ? AND timestamp >= date('now', 'start of month')"
  ).get(userId) as { total: number }).total;

  const total = (db.prepare(
    'SELECT COALESCE(SUM(cost_usd), 0) as total FROM api_usage WHERE user_id = ?'
  ).get(userId) as { total: number }).total;

  return { daily, monthly, total };
}

export function getUsageSummary(): Array<{ userId: string; daily: number; monthly: number; total: number }> {
  const db = getDb();
  const users = db.prepare('SELECT DISTINCT user_id FROM api_usage').all() as Array<{ user_id: string }>;
  return users.map(u => ({ userId: u.user_id, ...getUserUsage(u.user_id) }));
}
