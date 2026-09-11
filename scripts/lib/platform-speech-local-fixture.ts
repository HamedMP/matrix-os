import { createHmac, randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import pg from "pg";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const LOCAL_SPEECH_FIXTURE_PORTS = {
  shell: 3117,
  gateway: 4117,
  platform: 9117,
} as const;
export const LOCAL_SPEECH_FIXTURE_TRANSCRIPT = "Deterministic local speech fixture transcript";

export interface LocalSpeechFixturePlan {
  adminUrl: string;
  databaseName: string;
  databaseRole: string;
  databasePassword: string;
  databaseUrl: string;
  ownerDatabaseName: string;
  ownerDatabaseUrl: string;
  homePath: string;
  env: Record<string, string>;
}

export class LocalFixtureInterruptedError extends Error {
  constructor(readonly exitCode: 130 | 143) {
    super("Local speech fixture interrupted");
    this.name = "LocalFixtureInterruptedError";
  }
}

export class LocalFixtureSignalController {
  #activeChild: ChildProcess | undefined;
  #activeCancellation: (() => void) | undefined;
  #receivedSignal: "SIGINT" | "SIGTERM" | undefined;

  get exitCode(): 130 | 143 | undefined {
    if (this.#receivedSignal === "SIGINT") return 130;
    if (this.#receivedSignal === "SIGTERM") return 143;
    return undefined;
  }

  attach(child: ChildProcess): void {
    this.#activeChild = child;
    if (this.#receivedSignal) this.#signalActive(this.#receivedSignal);
  }

  detach(child: ChildProcess): void {
    if (this.#activeChild === child) this.#activeChild = undefined;
  }

  attachCancellation(cancel: () => void): void {
    this.#activeCancellation = cancel;
    if (this.#receivedSignal) cancel();
  }

  detachCancellation(cancel: () => void): void {
    if (this.#activeCancellation === cancel) this.#activeCancellation = undefined;
  }

  receive(signal: "SIGINT" | "SIGTERM"): void {
    if (this.#receivedSignal) return;
    this.#receivedSignal = signal;
    this.#signalActive(signal);
    this.#activeCancellation?.();
  }

  throwIfReceived(): void {
    const exitCode = this.exitCode;
    if (exitCode !== undefined) throw new LocalFixtureInterruptedError(exitCode);
  }

  #signalActive(signal: "SIGINT" | "SIGTERM"): void {
    const pid = this.#activeChild?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}

export async function completeLocalSpeechFixtureCleanup(
  exitCode: number,
  steps: Array<{ label: string; run: () => Promise<void> }>,
  report: (message: string) => void = (message) => console.error(message),
): Promise<number> {
  if (steps.length > 8) throw new Error("Local speech fixture cleanup has too many steps");
  let cleanupFailed = false;
  for (const step of steps) {
    try {
      await step.run();
    } catch (_error: unknown) {
      cleanupFailed = true;
      report(`Local speech fixture cleanup failed safely: ${step.label}`);
    }
  }
  return cleanupFailed ? 1 : exitCode;
}

export function parseLocalPostgresAdminUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    if (!(error instanceof TypeError)) throw error;
    throw new Error("Speech fixture admin URL must be a valid PostgreSQL URL");
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error("Speech fixture admin URL must be a PostgreSQL URL");
  }
  if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error("Speech fixture admin URL must use a loopback PostgreSQL host");
  }
  if (!url.pathname || url.pathname === "/") {
    throw new Error("Speech fixture admin URL must name an administrative database");
  }
  return url;
}

export function createBoundedLocalPostgresAdminClient(
  value: string,
  overrides: { connectionTimeoutMillis?: number } = {},
): pg.Client {
  const url = parseLocalPostgresAdminUrl(value);
  const connectionTimeoutMillis = overrides.connectionTimeoutMillis ?? 5_000;
  if (!Number.isSafeInteger(connectionTimeoutMillis)
    || connectionTimeoutMillis < 100
    || connectionTimeoutMillis > 30_000) {
    throw new Error("Local PostgreSQL connection timeout is out of bounds");
  }
  return new pg.Client({
    connectionString: url.toString(),
    connectionTimeoutMillis,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    lock_timeout: 5_000,
  });
}

export function cancelBoundedLocalPostgresAdminClient(client: pg.Client): Promise<void> {
  // node-postgres end() waits for its connect timeout during an incomplete startup
  // handshake, so close this task-owned loopback socket before ending the client.
  const connection = client as pg.Client & {
    connection?: { stream?: { destroy: (error?: Error) => void; destroyed?: boolean } };
  };
  const stream = connection.connection?.stream;
  if (stream && !stream.destroyed) {
    stream.destroy(new Error("Local speech fixture PostgreSQL administration interrupted"));
  }
  return client.end().catch(() => undefined);
}

function runtimeToken(identity: {
  handle: string;
  machineId: string;
  runtimeSlot: string;
}, platformSecret: string): string {
  return createHmac("sha256", platformSecret)
    .update(JSON.stringify([
      "matrix-funded-ai-runtime",
      1,
      identity.handle,
      identity.machineId,
      identity.runtimeSlot,
    ]))
    .digest("hex");
}

export function createLocalSpeechFixturePlan(options: {
  adminUrl: string;
  randomHex?: (bytes: number) => string;
  temporaryRoot?: string;
}): LocalSpeechFixturePlan {
  const admin = parseLocalPostgresAdminUrl(options.adminUrl);
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const suffix = randomHex(12);
  if (!/^[a-f0-9]{24}$/.test(suffix)) throw new Error("Speech fixture random source returned an invalid suffix");
  const databaseName = `matrixos_speech_fixture_test_${suffix}`;
  const ownerDatabaseName = `${databaseName}_owner`;
  const databaseRole = `matrixos_speech_fixture_test_role_${suffix}`;
  const database = new URL(admin);
  database.pathname = `/${databaseName}`;
  const databasePassword = randomHex(32);
  database.username = databaseRole;
  database.password = databasePassword;
  const ownerDatabase = new URL(database);
  ownerDatabase.pathname = `/${ownerDatabaseName}`;
  const platformSecret = randomHex(32);
  const speechSecret = randomHex(32);
  const gatewayToken = randomHex(32);
  for (const generated of [databasePassword, platformSecret, speechSecret, gatewayToken]) {
    if (!/^[a-f0-9]{64}$/.test(generated)) throw new Error("Speech fixture random source returned an invalid secret");
  }
  const identity = {
    handle: `speech-${suffix.slice(0, 12)}`,
    machineId: `machine_${suffix}`,
    runtimeSlot: "primary",
    ownerId: `user_${suffix}`,
  };
  const homePath = join(options.temporaryRoot ?? "/tmp", `${databaseName}-home`);
  const shellOrigin = `http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.shell}`;
  const gatewayOrigin = `http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.gateway}`;
  const platformOrigin = `http://127.0.0.1:${LOCAL_SPEECH_FIXTURE_PORTS.platform}`;
  return {
    adminUrl: admin.toString(),
    databaseName,
    databaseRole,
    databasePassword,
    databaseUrl: database.toString(),
    ownerDatabaseName,
    ownerDatabaseUrl: ownerDatabase.toString(),
    homePath,
    env: {
      NODE_ENV: "development",
      PLATFORM_RUNTIME_MODE: "local",
      PLATFORM_BACKGROUND_WORKERS_ENABLED: "false",
      PLATFORM_DATABASE_URL: database.toString(),
      DATABASE_URL: ownerDatabase.toString(),
      PLATFORM_SECRET: platformSecret,
      PLATFORM_PORT: String(LOCAL_SPEECH_FIXTURE_PORTS.platform),
      PLATFORM_INTERNAL_URL: platformOrigin,
      PLATFORM_SPEECH_ENABLED: "true",
      PLATFORM_SPEECH_PROVIDER: "fixture",
      PLATFORM_SPEECH_POLICY_REVISION: "local-fixture-1",
      PLATFORM_SPEECH_FIXTURE_TRANSCRIPT: LOCAL_SPEECH_FIXTURE_TRANSCRIPT,
      PLATFORM_SPEECH_SECRET: speechSecret,
      PLATFORM_SPEECH_OPENAI_API_KEY: "",
      MATRIX_PLATFORM_SPEECH_ENABLED: "true",
      MATRIX_HANDLE: identity.handle,
      MATRIX_MACHINE_ID: identity.machineId,
      MATRIX_RUNTIME_SLOT: identity.runtimeSlot,
      MATRIX_CLERK_USER_ID: identity.ownerId,
      MATRIX_USER_ID: identity.ownerId,
      MATRIX_FUNDED_AI_RUNTIME_TOKEN: runtimeToken(identity, platformSecret),
      MATRIX_AUTH_TOKEN: gatewayToken,
      UPGRADE_TOKEN: gatewayToken,
      MATRIX_HOME: homePath,
      MATRIX_SPEECH_GATEWAY_PORT: String(LOCAL_SPEECH_FIXTURE_PORTS.gateway),
      MATRIX_SPEECH_SHELL_PORT: String(LOCAL_SPEECH_FIXTURE_PORTS.shell),
      GATEWAY_URL: gatewayOrigin,
      NEXT_PUBLIC_GATEWAY_WS: `${gatewayOrigin.replace("http:", "ws:")}/ws`,
      SHELL_ORIGIN: shellOrigin,
      E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_TEST_BYPASS: "1",
      NEXT_PUBLIC_E2E_AUTHENTICATE_WS: "1",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_Y2ktc2FmZS5leGFtcGxlLmNvbSQ=",
    },
  };
}

function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`Speech fixture port ${port} is already in use`));
      } else {
        reject(error);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => error ? reject(error) : resolve());
    });
  });
}

export async function assertFixturePortsAvailable(
  ports: readonly number[] = Object.values(LOCAL_SPEECH_FIXTURE_PORTS),
): Promise<void> {
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error("Speech fixture ports must be unprivileged TCP ports");
    }
    await assertPortAvailable(port);
  }
}
