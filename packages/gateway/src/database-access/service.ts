import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import pg from "pg";
import { CompiledQuery, Kysely, PostgresDialect } from "kysely";

const USERNAME = "matrix_owner";
const PRIVATE_SCHEMA = "_matrix_owner_access";
const UNAVAILABLE = "Database access unavailable";
const DATA_PRIVILEGES = "SELECT, INSERT, UPDATE, DELETE, TRUNCATE";

export interface DatabaseAccessService {
  info(): Promise<{ connection: { host: string; port: number; database: string; username: string }; credentialReady: boolean }>;
  reveal(): Promise<{ username: string; password: string }>;
  reset(): Promise<{ username: string; password: string }>;
  consoleCommand(): Promise<string>;
  close(): Promise<void>;
}

export interface DatabaseAccessServiceOptions {
  databaseUrl: string;
  ownerId: string;
  key: Buffer;
  /** The service owns and closes the returned pool. */
  poolFactory?: (config: pg.PoolConfig) => Pick<pg.Pool, "connect" | "end" | "on">;
}

function binding(ownerId: string, database: string): Buffer {
  return Buffer.from(JSON.stringify(["matrix-owner-database-password-v1", ownerId, database]));
}

export function sealDatabasePassword(key: Buffer, ownerId: string, database: string, password: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(binding(ownerId, database));
  const ciphertext = Buffer.concat([cipher.update(password, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
}

export function openDatabasePassword(key: Buffer, ownerId: string, database: string, sealed: string): string {
  if (sealed.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(sealed)) throw new Error(UNAVAILABLE);
  const bytes = Buffer.from(sealed, "base64url");
  if (bytes.length < 29) throw new Error(UNAVAILABLE);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(binding(ownerId, database));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
}

/** PostgreSQL's SCRAM verifier format; raw passwords never enter SQL text or server statement logs. */
function passwordVerifier(password: string): string {
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, 4096, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$4096:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

async function passwordMatches(client: SqlClient, password: string): Promise<boolean> {
  const { rows } = await client.query<{ verifier: string | null }>(`/* role-password */
    SELECT rolpassword AS verifier FROM pg_authid WHERE rolname = 'matrix_owner'`);
  const verifier = rows[0]?.verifier;
  if (!verifier || verifier.length > 256) return false;
  const parts = /^SCRAM-SHA-256\$(\d{4,5}):([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$/.exec(verifier);
  if (!parts) return false;
  const iterations = Number(parts[1]);
  // Bound work even if the owner directly installs a malicious verifier through ALTER ROLE.
  if (iterations < 4096 || iterations > 32768) return false;
  const salted = pbkdf2Sync(password, Buffer.from(parts[2], "base64"), iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return Boolean(Number(timingSafeEqual(storedKey, Buffer.from(parts[3], "base64")))
    & Number(timingSafeEqual(serverKey, Buffer.from(parts[4], "base64"))));
}

function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function parseConfiguration(options: DatabaseAccessServiceOptions) {
  let url: URL;
  try { url = new URL(options.databaseUrl); } catch (error) {
    if (error instanceof TypeError) throw new Error(UNAVAILABLE);
    throw error;
  }
  // Only the dedicated customer-VPS layout is supported. Shared/platform/custom databases fail closed.
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost"].includes(url.hostname)
    || url.search || url.hash || url.username !== "matrix" || !url.password || url.pathname !== "/matrix"
    || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(options.ownerId) || options.key.length !== 32) throw new Error(UNAVAILABLE);
  const host = "127.0.0.1";
  const port = Number(url.port || 5432);
  return { url, host, port, database: "matrix" };
}

interface SqlClient {
  query<Row = Record<string, unknown>>(statement: string, parameters?: unknown[]): Promise<{ rows: Row[] }>;
}

async function assertDedicated(client: SqlClient): Promise<void> {
  const { rows } = await client.query<{ dedicated: boolean }>(`/* dedicated-runtime */
    SELECT current_database() = 'matrix' AND current_user = 'matrix' AND session_user = 'matrix'
      AND EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba
        WHERE d.datname = current_database() AND r.rolname = 'matrix')
      AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolsuper)
      AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname NOT IN ('matrix', 'postgres', 'template0', 'template1'))
      AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname !~ '^pg_' AND rolname NOT IN ('matrix', 'postgres', 'matrix_owner'))
      AS dedicated`);
  if (rows[0]?.dedicated !== true) throw new Error(UNAVAILABLE);
}

async function assertRole(client: SqlClient): Promise<boolean> {
  const { rows } = await client.query<{ exists: boolean; unsafe: boolean }>(`/* unsafe-role */
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'matrix_owner') AS exists,
      EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = 'matrix_owner' AND
        (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls
          OR r.rolinherit OR NOT r.rolcanlogin OR r.rolconnlimit <> 4
          OR EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid OR m.roleid = r.oid)
          OR EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid)
          OR EXISTS (SELECT 1 FROM pg_db_role_setting s WHERE s.setrole = r.oid))) AS unsafe`);
  if (!rows[0] || rows[0].unsafe) throw new Error(UNAVAILABLE);
  return rows[0].exists;
}

async function reconcileGrants(client: SqlClient): Promise<void> {
  // PUBLIC execution can bypass an otherwise restricted role through SECURITY DEFINER routines.
  // Do not mutate application routines; require support review for this unsupported layout.
  const functions = await client.query<{ unsafe: boolean }>(`/* unsafe-functions */
    SELECT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.prosecdef AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND n.nspname <> 'information_schema'
      AND has_function_privilege('matrix_owner', p.oid, 'EXECUTE')) AS unsafe`);
  if (functions.rows[0]?.unsafe !== false) throw new Error(UNAVAILABLE);
  const { rows } = await client.query<{ name: string }>(`/* app-schemas */
    SELECT nspname AS name FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND nspname NOT IN ('information_schema', '_matrix_owner_access') ORDER BY nspname LIMIT 129`);
  if (rows.length > 128) throw new Error(UNAVAILABLE);
  const schemas = rows.map(({ name }) => identifier(name)).join(", ");
  await client.query('GRANT CONNECT ON DATABASE "matrix" TO "matrix_owner"');
  // The dedicated runtime requires PostgreSQL 15+ defaults: no PUBLIC schema CREATE privilege.
  // Older/custom layouts fail instead of widening role or changing global PUBLIC permissions.
  const unsafeSchema = await client.query<{ unsafe: boolean }>(`/* unsafe-schema */
    SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND has_schema_privilege('matrix_owner', oid, 'CREATE')) AS unsafe`);
  if (unsafeSchema.rows[0]?.unsafe !== false) throw new Error(UNAVAILABLE);
  if (!schemas) return;
  await client.query(`GRANT USAGE ON SCHEMA ${schemas} TO "matrix_owner"`);
  await client.query(`GRANT ${DATA_PRIVILEGES} ON ALL TABLES IN SCHEMA ${schemas} TO "matrix_owner"`);
  await client.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA ${schemas} TO "matrix_owner"`);
  // Schema-specific defaults cover future tables, not future schemas. Every explicit Settings action reconciles schemas.
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "matrix" IN SCHEMA ${schemas} GRANT ${DATA_PRIVILEGES} ON TABLES TO "matrix_owner"`);
  await client.query(`ALTER DEFAULT PRIVILEGES FOR ROLE "matrix" IN SCHEMA ${schemas} GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO "matrix_owner"`);
}

export function createDatabaseAccessService(options: DatabaseAccessServiceOptions): DatabaseAccessService {
  const config = parseConfiguration(options);
  const key = Buffer.from(options.key);
  const database = new Kysely<Record<string, never>>({ dialect: new PostgresDialect({
    // Allocate lazily so destroying an unused service has no pool to leak.
    pool: async () => {
      const pool = (options.poolFactory ?? ((input) => new pg.Pool(input)))({
        host: config.host, port: config.port, database: config.database, user: "matrix", password: decodeURIComponent(config.url.password),
        max: 2, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000,
        statement_timeout: 10_000, query_timeout: 12_000, lock_timeout: 5_000,
        idle_in_transaction_session_timeout: 10_000, application_name: "matrix-owner-database-access",
      });
      pool.on("error", () => console.error("[database-access] Idle connection failed"));
      return pool;
    },
  }) });
  let closed = false;
  let closing: Promise<void> | undefined;

  async function transaction<T>(operation: (client: SqlClient) => Promise<T>): Promise<T> {
    if (closed) throw new Error(UNAVAILABLE);
    try {
      return await database.transaction().execute(async (trx) => {
        const client: SqlClient = {
          query: (statement, parameters = []) => trx.executeQuery(CompiledQuery.raw(statement, parameters)),
        };
        // Fixed database-wide lock serializes initialization, reveal, and rotation across processes/owners.
        await client.query("SELECT pg_advisory_xact_lock(1835102834, 1684108385)");
        await assertDedicated(client);
        return operation(client);
      });
    } catch (error) {
      console.error("[database-access] Operation failed", error instanceof Error ? error.name : "Error");
      throw new Error(UNAVAILABLE);
    }
  }

  async function readCredential(client: SqlClient): Promise<string | undefined> {
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${PRIVATE_SCHEMA}" AUTHORIZATION "matrix"`);
    await client.query(`REVOKE ALL ON SCHEMA "${PRIVATE_SCHEMA}" FROM PUBLIC`);
    await client.query(`CREATE TABLE IF NOT EXISTS "${PRIVATE_SCHEMA}".credentials (
      database_name text PRIMARY KEY, owner_id text NOT NULL, sealed text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${PRIVATE_SCHEMA}" FROM PUBLIC`);
    const { rows } = await client.query<{ owner_id: string; sealed: string }>(`/* owner-credential */
      SELECT owner_id, sealed FROM "${PRIVATE_SCHEMA}".credentials WHERE database_name = $1 FOR UPDATE`, [config.database]);
    if (rows[0] && rows[0].owner_id !== options.ownerId) throw new Error(UNAVAILABLE);
    return rows[0]?.sealed;
  }

  async function credentials(rotate: boolean) {
    return transaction(async (client) => {
      const sealed = await readCredential(client);
      const exists = await assertRole(client);
      if (exists && !sealed) throw new Error(UNAVAILABLE);
      // A missing/different key is not permission to take over an existing credential, even on reset.
      const previous = sealed ? openDatabasePassword(key, options.ownerId, config.database, sealed) : undefined;
      if (previous && !/^[A-Za-z0-9_-]{43}$/.test(previous)) throw new Error(UNAVAILABLE);
      if (previous && exists && !rotate && !await passwordMatches(client, previous)) throw new Error(UNAVAILABLE);
      const password = previous && !rotate && exists ? previous : randomBytes(32).toString("base64url");
      if (!exists) {
        await client.query(`CREATE ROLE "matrix_owner" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 4 PASSWORD '${passwordVerifier(password)}'`);
      } else if (rotate) {
        await client.query(`ALTER ROLE "matrix_owner" PASSWORD '${passwordVerifier(password)}'`);
      }
      if (!previous || rotate || !exists) {
        await client.query(`/* save-credential */ INSERT INTO "${PRIVATE_SCHEMA}".credentials (database_name, owner_id, sealed)
          VALUES ($1, $2, $3) ON CONFLICT (database_name) DO UPDATE SET sealed = EXCLUDED.sealed, updated_at = now()`,
        [config.database, options.ownerId, sealDatabasePassword(key, options.ownerId, config.database, password)]);
      }
      await client.query(`REVOKE ALL ON SCHEMA "${PRIVATE_SCHEMA}" FROM "matrix_owner"`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA "${PRIVATE_SCHEMA}" FROM "matrix_owner"`);
      await reconcileGrants(client);
      return { username: USERNAME, password };
    });
  }

  return {
    async info() {
      return transaction(async (client) => {
        const sealed = await readCredential(client);
        const exists = await assertRole(client);
        if (exists && !sealed) throw new Error(UNAVAILABLE);
        const password = sealed ? openDatabasePassword(key, options.ownerId, config.database, sealed) : undefined;
        const ready = Boolean(password && exists && await passwordMatches(client, password));
        return { connection: { host: config.host, port: config.port, database: config.database, username: USERNAME }, credentialReady: ready };
      });
    },
    reveal: () => credentials(false),
    reset: () => credentials(true),
    async consoleCommand() {
      await credentials(false);
      return `psql -h ${config.host} -p ${config.port} -U ${USERNAME} -d ${config.database} -W`;
    },
    close() {
      if (!closing) { closed = true; closing = database.destroy().finally(() => key.fill(0)); }
      return closing;
    },
  };
}
