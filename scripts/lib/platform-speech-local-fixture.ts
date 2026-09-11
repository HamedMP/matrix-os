import { createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";

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

export async function assertFixturePortsAvailable(ports = Object.values(LOCAL_SPEECH_FIXTURE_PORTS)): Promise<void> {
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1_024 || port > 65_535) {
      throw new Error("Speech fixture ports must be unprivileged TCP ports");
    }
    await assertPortAvailable(port);
  }
}
