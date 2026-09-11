#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import pg from "pg";
import { createPlatformDb, insertUserMachine, type PlatformDB } from "../packages/platform/src/db.js";
import {
  LocalFixtureVerificationError,
  verifyComposedSpeech,
} from "./lib/platform-speech-local-browser.js";
import {
  assertFixturePortsAvailable,
  createLocalSpeechFixturePlan,
  LOCAL_SPEECH_FIXTURE_PORTS,
  type LocalSpeechFixturePlan,
} from "./lib/platform-speech-local-fixture.js";

const DATABASE_NAME = /^matrixos_speech_fixture_test_[a-f0-9]{24}(?:_owner)?$/;
const DATABASE_ROLE = /^matrixos_speech_fixture_test_role_[a-f0-9]{24}$/;
const launcher = resolve("scripts/dev-speech-stack.mjs");

function quoteIdentifier(value: string): string {
  if (!DATABASE_NAME.test(value) && !DATABASE_ROLE.test(value)) {
    throw new Error("Refusing to use a non-fixture database identifier");
  }
  return `"${value}"`;
}

async function createFixtureRole(admin: pg.Client, plan: LocalSpeechFixturePlan): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(plan.databasePassword)) {
    throw new Error("Refusing to use an invalid fixture database password");
  }
  await admin.query(
    `CREATE ROLE ${quoteIdentifier(plan.databaseRole)} LOGIN PASSWORD '${plan.databasePassword}'`,
  );
}

async function createFixtureDatabase(admin: pg.Client, plan: LocalSpeechFixturePlan, name: string): Promise<void> {
  await admin.query(
    `CREATE DATABASE ${quoteIdentifier(name)} OWNER ${quoteIdentifier(plan.databaseRole)} TEMPLATE template0 ENCODING 'UTF8'`,
  );
}

async function dropFixtureDatabase(admin: pg.Client, name: string): Promise<void> {
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE)`);
}

async function dropFixtureRole(admin: pg.Client, plan: LocalSpeechFixturePlan): Promise<void> {
  await admin.query(`DROP ROLE IF EXISTS ${quoteIdentifier(plan.databaseRole)}`);
}

function childCompletion(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolveCompletion, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolveCompletion({ code, signal }));
  });
}

async function runDockerPsql(options: {
  container: string;
  adminUser: string;
  sql: string;
}): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(options.container)
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(options.adminUser)) {
    throw new Error("Local PostgreSQL container configuration is invalid");
  }
  const child = spawn("docker", [
    "exec", "-i", options.container,
    "psql", "--no-psqlrc", "--quiet", "--set", "ON_ERROR_STOP=1",
    "--username", options.adminUser, "--dbname", "postgres",
  ], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin?.end(options.sql);
  const result = await childCompletion(child);
  if (result.code !== 0) throw new Error("Local PostgreSQL container administration failed");
}

async function readDockerPostgresUser(container: string): Promise<string> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(container)) {
    throw new Error("Local PostgreSQL container configuration is invalid");
  }
  const child = spawn("docker", ["exec", container, "printenv", "POSTGRES_USER"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    if (output.length <= 1_024) output += chunk;
  });
  const result = await childCompletion(child);
  const user = output.trim();
  if (result.code !== 0 || output.length > 1_024
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(user)) {
    throw new Error("Could not detect the local PostgreSQL container user");
  }
  return user;
}

async function runPostgresConcurrencyTests(plan: LocalSpeechFixturePlan): Promise<void> {
  console.log("Running five speech concurrency tests against the disposable PostgreSQL database...");
  const child = spawn(resolve("node_modules/.bin/vitest"), [
    "run",
    "tests/platform/speech-postgres-concurrency.test.ts",
    "--maxWorkers=1",
    "--no-file-parallelism",
  ], {
    cwd: resolve("."),
    env: {
      ...process.env,
      MATRIX_TEST_POSTGRES_URL: plan.databaseUrl,
      PLATFORM_SPEECH_OPENAI_API_KEY: "",
      PLATFORM_SPEECH_SECRET: "",
    },
    stdio: "inherit",
  });
  const result = await childCompletion(child);
  if (result.code !== 0) throw new Error("Disposable PostgreSQL speech concurrency tests failed");
}

async function waitForHttp(url: string, stackCompletion: Promise<unknown>): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const probe = fetch(url, { redirect: "error", signal: AbortSignal.timeout(2_000) })
      .then((response) => response.ok)
      .catch(() => false);
    const outcome = await Promise.race([
      probe.then((ready) => ({ kind: "probe" as const, ready })),
      stackCompletion.then(() => ({ kind: "stack" as const, ready: false })),
    ]);
    if (outcome.kind === "stack") throw new Error("Speech stack exited before becoming ready");
    if (outcome.ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  throw new Error(`Timed out waiting for local service at ${url}`);
}

async function run(): Promise<number> {
  // The orchestration process never needs an operator/provider credential.
  process.env.PLATFORM_SPEECH_OPENAI_API_KEY = "";
  process.env.PLATFORM_SPEECH_SECRET = "";
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--verify")) {
    console.error("Usage: bun run dev:speech:fixture -- [--verify]");
    return 2;
  }
  const verify = args.includes("--verify");
  const explicitAdminUrl = process.env.MATRIX_SPEECH_FIXTURE_POSTGRES_ADMIN_URL;
  const postgresHost = process.env.MATRIX_SPEECH_FIXTURE_POSTGRES_HOST ?? "127.0.0.1";
  const postgresPort = process.env.MATRIX_SPEECH_FIXTURE_POSTGRES_PORT ?? "5432";
  if (!/^(?:127(?:\.[0-9]{1,3}){3}|localhost|\[?::1\]?)$/.test(postgresHost)
    || !/^[0-9]{2,5}$/.test(postgresPort)) {
    console.error("Local speech fixture requires a loopback PostgreSQL host and valid port");
    return 2;
  }
  const plan = createLocalSpeechFixturePlan({
    adminUrl: explicitAdminUrl ?? `postgresql://local-admin@${postgresHost}:${postgresPort}/postgres`,
    temporaryRoot: tmpdir(),
  });
  await assertFixturePortsAvailable();

  const admin = explicitAdminUrl ? new pg.Client({ connectionString: plan.adminUrl }) : undefined;
  const dockerContainer = process.env.MATRIX_SPEECH_FIXTURE_POSTGRES_CONTAINER ?? "matrix-postgres";
  const dockerAdmin = explicitAdminUrl ? undefined : {
    container: dockerContainer,
    adminUser: process.env.MATRIX_SPEECH_FIXTURE_POSTGRES_ADMIN_USER
      ?? await readDockerPostgresUser(dockerContainer),
  };
  let databaseCreated = false;
  let ownerDatabaseCreated = false;
  let roleCreated = false;
  let db: PlatformDB | undefined;
  let stack: ChildProcess | undefined;
  let plannedStop = false;
  let receivedSignal: "SIGINT" | "SIGTERM" | undefined;
  const forwardSignal = (signal: "SIGINT" | "SIGTERM") => {
    if (receivedSignal) return;
    receivedSignal = signal;
    stack?.kill(signal);
  };
  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  let stage = "local PostgreSQL preflight";
  try {
    if (admin) await admin.connect();
    if (admin) await createFixtureRole(admin, plan);
    else await runDockerPsql({
      ...dockerAdmin!,
      sql: `CREATE ROLE ${quoteIdentifier(plan.databaseRole)} LOGIN PASSWORD '${plan.databasePassword}';\n`,
    });
    roleCreated = true;
    if (admin) await createFixtureDatabase(admin, plan, plan.databaseName);
    else await runDockerPsql({
      ...dockerAdmin!,
      sql: `CREATE DATABASE ${quoteIdentifier(plan.databaseName)} OWNER ${quoteIdentifier(plan.databaseRole)} TEMPLATE template0 ENCODING 'UTF8';\n`,
    });
    databaseCreated = true;
    if (admin) await createFixtureDatabase(admin, plan, plan.ownerDatabaseName);
    else await runDockerPsql({
      ...dockerAdmin!,
      sql: `CREATE DATABASE ${quoteIdentifier(plan.ownerDatabaseName)} OWNER ${quoteIdentifier(plan.databaseRole)} TEMPLATE template0 ENCODING 'UTF8';\n`,
    });
    ownerDatabaseCreated = true;
    stage = "fixture database migration";
    await mkdir(plan.homePath, { recursive: false });
    db = createPlatformDb(plan.databaseUrl);
    await db.ready;
    await insertUserMachine(db, {
      machineId: plan.env.MATRIX_MACHINE_ID,
      clerkUserId: plan.env.MATRIX_CLERK_USER_ID,
      handle: plan.env.MATRIX_HANDLE,
      runtimeSlot: plan.env.MATRIX_RUNTIME_SLOT,
      status: "running",
      imageVersion: "local-speech-fixture",
      provisionedAt: new Date().toISOString(),
      activationState: "authorized",
    });
    if (verify) {
      stage = "real PostgreSQL concurrency tests";
      await runPostgresConcurrencyTests(plan);
    }

    console.log(`Disposable speech fixture databases: ${plan.databaseName}, ${plan.ownerDatabaseName}`);
    console.log(`Platform: http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.platform}`);
    console.log(`Gateway: http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.gateway}`);
    console.log(`Web shell: http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.shell}/?launch=__chat__`);
    console.log("Provider: deterministic fixture (no external provider call or funded-ledger debit)");

    stage = "composed stack startup";
    stack = spawn(process.execPath, [launcher], {
      cwd: resolve("."),
      env: { ...process.env, ...plan.env },
      stdio: "inherit",
    });
    const completed = childCompletion(stack);
    if (verify) {
      await Promise.all([
        waitForHttp(`http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.platform}/health`, completed),
        waitForHttp(`http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.gateway}/health`, completed),
        waitForHttp(`http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.shell}/`, completed),
      ]);
      stage = "authenticated browser record-stop-transcribe";
      await verifyComposedSpeech(plan, db);
      console.log("Verified authenticated browser record -> stop -> fixture transcribe -> editable draft.");
      plannedStop = true;
      stack.kill("SIGTERM");
    }
    const result = await completed;
    if (receivedSignal) return receivedSignal === "SIGINT" ? 130 : 143;
    if (plannedStop && result.code === 143) return 0;
    return result.code ?? 1;
  } catch (error: unknown) {
    const diagnostic = error instanceof Error
      ? `${error.name}${"code" in error && typeof error.code === "string" ? ` (${error.code})` : ""}`
      : "UnknownError";
    const safeCode = error instanceof LocalFixtureVerificationError ? ` [${error.code}]` : "";
    console.error(`Local speech fixture failed safely during ${stage}: ${diagnostic}${safeCode}`);
    if (stack && stack.exitCode === null && stack.signalCode === null) {
      stack.kill("SIGTERM");
      await childCompletion(stack).catch(() => undefined);
    }
    return 1;
  } finally {
    await db?.destroy().catch(() => undefined);
    if (ownerDatabaseCreated) {
      if (admin) await dropFixtureDatabase(admin, plan.ownerDatabaseName).catch(() => undefined);
      else await runDockerPsql({
        ...dockerAdmin!,
        sql: `DROP DATABASE IF EXISTS ${quoteIdentifier(plan.ownerDatabaseName)} WITH (FORCE);\n`,
      }).catch(() => undefined);
    }
    if (databaseCreated) {
      if (admin) await dropFixtureDatabase(admin, plan.databaseName).catch(() => undefined);
      else await runDockerPsql({
        ...dockerAdmin!,
        sql: `DROP DATABASE IF EXISTS ${quoteIdentifier(plan.databaseName)} WITH (FORCE);\n`,
      }).catch(() => undefined);
    }
    if (roleCreated) {
      if (admin) await dropFixtureRole(admin, plan).catch(() => undefined);
      else await runDockerPsql({
        ...dockerAdmin!,
        sql: `DROP ROLE IF EXISTS ${quoteIdentifier(plan.databaseRole)};\n`,
      }).catch(() => undefined);
    }
    await admin?.end().catch(() => undefined);
    if (plan.homePath.startsWith(`${tmpdir()}/matrixos_speech_fixture_test_`) && plan.homePath.endsWith("-home")) {
      await rm(plan.homePath, { recursive: true, force: true });
    }
  }
}

process.exitCode = await run();
