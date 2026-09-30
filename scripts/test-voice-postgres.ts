/**
 * test:voice:postgres — run the canonical voice PostgreSQL suites against an
 * isolated database. Never silently skips real-Postgres coverage:
 *
 *   1. MATRIX_TEST_POSTGRES_URL already set → run against it (must name a
 *      dedicated test database, per tests/gateway/collaboration-test-support).
 *   2. MATRIX_VOICE_POSTGRES_ADMIN_URL → loopback admin URL; a disposable
 *      `matrix_voice_test_<hex>` database is created, tested, and dropped.
 *   3. A reachable local docker postgres container (default `matrix-postgres`,
 *      override via MATRIX_VOICE_POSTGRES_CONTAINER) → same create/run/drop.
 *   4. None available → exit non-zero with an actionable message.
 *
 * Extra args are forwarded to vitest.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import {
  createBoundedLocalPostgresAdminClient,
  waitForBoundedChildProcess,
} from "./lib/platform-speech-local-fixture.js";

const VITEST_ARGS = ["run", "tests/gateway/chat-voice", "tests/gateway/voice-session"];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

function quoteIdentifier(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error(`unsafe identifier: ${name}`);
  return `"${name}"`;
}

function childClose(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolveClose, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolveClose(code ?? 1));
  });
}

async function dockerPsql(container: string, user: string, sql: string): Promise<void> {
  if (!SAFE_NAME.test(container) || !SAFE_NAME.test(user)) {
    throw new Error("PostgreSQL container configuration is invalid");
  }
  const child = spawn("docker", [
    "exec", "-i", container,
    "psql", "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1",
    "--username", user, "--dbname", "postgres",
  ], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin?.end(sql);
  const result = await waitForBoundedChildProcess(child, { timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error("container PostgreSQL administration failed");
}

async function dockerPostgresUser(container: string): Promise<string> {
  if (!SAFE_NAME.test(container)) throw new Error("PostgreSQL container name is invalid");
  const child = spawn("docker", ["exec", container, "printenv", "POSTGRES_USER"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (output.length <= 256) output += chunk;
  });
  const result = await waitForBoundedChildProcess(child, { timeoutMs: 10_000 });
  const user = output.trim();
  if (result.code !== 0 || !SAFE_NAME.test(user)) {
    throw new Error("local PostgreSQL container is not reachable");
  }
  return user;
}

async function runVitest(databaseUrl: string, extra: string[]): Promise<number> {
  const child = spawn(resolve("node_modules/.bin/vitest"), [
    ...VITEST_ARGS,
    ...extra,
  ], {
    cwd: resolve("."),
    env: { ...process.env, MATRIX_TEST_POSTGRES_URL: databaseUrl },
    stdio: "inherit",
  });
  return childClose(child);
}

function existingUrlIsUsable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return /test/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

async function provisionViaAdminUrl(adminUrl: string, database: string): Promise<string> {
  const admin = createBoundedLocalPostgresAdminClient(adminUrl);
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
  } finally {
    await admin.end().catch(() => undefined);
  }
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

async function provisionViaDocker(container: string, database: string): Promise<string> {
  const user = await dockerPostgresUser(container);
  await dockerPsql(container, user, `CREATE DATABASE ${quoteIdentifier(database)};`);
  const hostPort = process.env.MATRIX_VOICE_POSTGRES_PORT ?? "5432";
  const password = process.env.MATRIX_VOICE_POSTGRES_PASSWORD ?? user;
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${hostPort}/${database}`;
}

async function dropProvisionedDatabase(options: {
  adminUrl?: string;
  container?: string;
  database: string;
}): Promise<void> {
  const sql = `DROP DATABASE IF EXISTS ${quoteIdentifier(options.database)};`;
  try {
    if (options.adminUrl) {
      const admin = createBoundedLocalPostgresAdminClient(options.adminUrl);
      await admin.connect();
      try {
        await admin.query(sql);
      } finally {
        await admin.end().catch(() => undefined);
      }
    } else if (options.container) {
      const user = await dockerPostgresUser(options.container);
      await dockerPsql(options.container, user, sql);
    }
  } catch (error: unknown) {
    console.warn(`[voice-postgres] cleanup failed for ${options.database}:`, error);
  }
}

async function main(): Promise<number> {
  const extra = process.argv.slice(2);

  const preset = process.env.MATRIX_TEST_POSTGRES_URL?.trim();
  if (preset) {
    if (!existingUrlIsUsable(preset)) {
      console.error(
        "[voice-postgres] MATRIX_TEST_POSTGRES_URL must name a dedicated test "
        + "database (path containing 'test'); refusing to run against it.",
      );
      return 2;
    }
    return runVitest(preset, extra);
  }

  const database = `matrix_voice_test_${randomBytes(6).toString("hex")}`;
  const adminUrl = process.env.MATRIX_VOICE_POSTGRES_ADMIN_URL?.trim();
  const container = process.env.MATRIX_VOICE_POSTGRES_CONTAINER ?? "matrix-postgres";

  let databaseUrl: string | null = null;
  let provisioned: { adminUrl?: string; container?: string; database: string } | null = null;

  if (adminUrl) {
    try {
      databaseUrl = await provisionViaAdminUrl(adminUrl, database);
      provisioned = { adminUrl, database };
    } catch (error: unknown) {
      console.warn("[voice-postgres] admin-URL provisioning failed:", error);
    }
  }
  if (!databaseUrl) {
    try {
      databaseUrl = await provisionViaDocker(container, database);
      provisioned = { container, database };
    } catch (error: unknown) {
      console.warn("[voice-postgres] container provisioning failed:", error);
    }
  }
  if (!databaseUrl || !provisioned) {
    console.error(
      "[voice-postgres] No isolated PostgreSQL available. Provide one of:\n"
      + "  MATRIX_TEST_POSTGRES_URL=<postgres url naming a test database>\n"
      + "  MATRIX_VOICE_POSTGRES_ADMIN_URL=<loopback postgres admin url>\n"
      + `  a running local container (${container}) from bun run dev:postgres/docker compose\n`
      + "Refusing to silently skip real-PostgreSQL voice coverage.",
    );
    return 2;
  }

  console.log(`[voice-postgres] provisioned ${database}`);
  try {
    return await runVitest(databaseUrl, extra);
  } finally {
    await dropProvisionedDatabase({ ...provisioned, database });
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error("[voice-postgres] fatal:", error);
    process.exit(2);
  });
