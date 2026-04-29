// One-shot migration: copy platform control-plane data from the legacy
// SQLite file at /data/platform.db into the new Postgres database.
// Idempotent via ON CONFLICT DO NOTHING. Run inside the platform container.

const Database = require('better-sqlite3');
const { Pool } = require('pg');

const SQLITE_PATH = process.env.SQLITE_PATH || '/data/platform.db';
const PG_URL = (process.env.POSTGRES_URL || '').replace(/\/$/, '') + '/matrixos_platform';

if (!process.env.POSTGRES_URL) {
  console.error('POSTGRES_URL is required');
  process.exit(1);
}

const sqlite = new Database(SQLITE_PATH, { readonly: true, fileMustExist: true });
const pool = new Pool({ connectionString: PG_URL, max: 4 });

const TABLES = [
  {
    name: 'containers',
    cols: ['handle', 'clerk_user_id', 'container_id', 'port', 'shell_port', 'status', 'created_at', 'last_active'],
    conflict: '(handle) DO NOTHING',
  },
  {
    name: 'matrix_users',
    cols: ['handle', 'human_matrix_id', 'ai_matrix_id', 'human_access_token', 'ai_access_token', 'created_at'],
    conflict: '(handle) DO NOTHING',
  },
  {
    name: 'apps_registry',
    cols: ['id', 'name', 'slug', 'author_id', 'description', 'category', 'tags', 'version', 'source_url', 'manifest', 'screenshots', 'installs', 'rating', 'ratings_count', 'forks_count', 'is_public', 'created_at', 'updated_at'],
    conflict: '(id) DO NOTHING',
    transform: (r) => ({ ...r, is_public: r.is_public === 1 || r.is_public === true }),
  },
  {
    name: 'app_installs',
    cols: ['app_id', 'user_id', 'installed_at'],
    conflict: '(app_id, user_id) DO NOTHING',
  },
  {
    name: 'app_ratings',
    cols: ['app_id', 'user_id', 'rating', 'review', 'created_at'],
    conflict: '(app_id, user_id) DO NOTHING',
  },
  {
    name: 'device_codes',
    cols: ['device_code', 'user_code', 'clerk_user_id', 'expires_at', 'last_polled_at', 'created_at'],
    conflict: '(device_code) DO NOTHING',
  },
  {
    name: 'port_assignments',
    cols: ['port', 'handle'],
    conflict: '(port) DO NOTHING',
  },
  {
    name: 'social_posts',
    cols: ['id', 'author_id', 'content', 'type', 'media_urls', 'app_ref', 'likes_count', 'comments_count', 'created_at'],
    conflict: '(id) DO NOTHING',
  },
  {
    name: 'social_comments',
    cols: ['id', 'post_id', 'author_id', 'content', 'created_at'],
    conflict: '(id) DO NOTHING',
  },
  {
    name: 'social_likes',
    cols: ['post_id', 'user_id', 'created_at'],
    conflict: '(post_id, user_id) DO NOTHING',
  },
  {
    name: 'social_follows',
    cols: ['follower_id', 'following_id', 'following_type', 'created_at'],
    conflict: '(follower_id, following_id) DO NOTHING',
  },
];

function placeholders(n, offset = 0) {
  return Array.from({ length: n }, (_, i) => `$${i + 1 + offset}`).join(', ');
}

async function tableExistsInSqlite(name) {
  const row = sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name);
  return !!row;
}

async function migrate(table) {
  const { name, cols, conflict, transform } = table;
  if (!(await tableExistsInSqlite(name))) {
    console.log(`[skip] sqlite table missing: ${name}`);
    return { name, copied: 0, total: 0 };
  }
  const rows = sqlite.prepare(`SELECT ${cols.join(', ')} FROM ${name}`).all();
  if (rows.length === 0) {
    console.log(`[skip] empty: ${name}`);
    return { name, copied: 0, total: 0 };
  }
  const insert = `INSERT INTO ${name} (${cols.join(', ')}) VALUES (${placeholders(cols.length)}) ON CONFLICT ${conflict}`;
  let copied = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const raw of rows) {
      const row = transform ? transform(raw) : raw;
      const values = cols.map((c) => row[c] ?? null);
      const res = await client.query(insert, values);
      copied += res.rowCount;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  return { name, copied, total: rows.length };
}

async function main() {
  console.log(`Source:  sqlite ${SQLITE_PATH}`);
  console.log(`Target:  postgres matrixos_platform`);
  try {
    const results = [];
    for (const table of TABLES) {
      try {
        const r = await migrate(table);
        results.push(r);
        console.log(`[ok] ${r.name}: copied=${r.copied} total=${r.total}`);
      } catch (err) {
        console.error(`[fail] ${table.name}: ${err.message}`);
        throw err;
      }
    }
    console.log('\nSummary:');
    for (const r of results) console.log(`  ${r.name}: copied=${r.copied}/${r.total}`);
  } finally {
    await pool.end();
    sqlite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
