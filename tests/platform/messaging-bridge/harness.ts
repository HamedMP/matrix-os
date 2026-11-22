import { Hono } from "hono";
import { insertUserMachine, type PlatformDB } from "../../../packages/platform/src/db.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { createConfiguredMessagingBridge } from "../../../packages/platform/src/messaging-bridge/startup.js";
import {
  ADMIN_TOKEN,
  APPSERVICE_TOKEN,
  GATE_SECRET,
  HOST_URL,
  PROVISIONING_SECRETS,
  SERVER_NAME,
  createFakeBridgeHost,
} from "./fake-bridge-host.js";

export const PLATFORM_SECRET = "platform-secret-for-messaging-bridge-tests";
export const USER_ID_KEY = "user-id-key-0123456789abcdef0123456789";

export const OWNERS = {
  alice: { handle: "alice", ownerId: "user_alice" },
  bob: { handle: "bob", ownerId: "user_bob" },
  carol: { handle: "carol", ownerId: "user_carol" },
} as const;

/** The bridge host's platform.env keys plus the platform-managed MESSAGING_BRIDGE_ALLOWED_HANDLES. */
export function bridgeEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {
    MESSAGING_BRIDGE_HOST_URL: HOST_URL,
    MESSAGING_BRIDGE_SERVER_NAME: SERVER_NAME,
    MESSAGING_BRIDGE_ADMIN_TOKEN: ADMIN_TOKEN,
    MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN: APPSERVICE_TOKEN,
    MESSAGING_BRIDGE_GATE_SECRET: GATE_SECRET,
    MESSAGING_BRIDGE_USER_ID_KEY: USER_ID_KEY,
    MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP: PROVISIONING_SECRETS.whatsapp,
    MESSAGING_BRIDGE_PROVISIONING_SECRET_TELEGRAM: PROVISIONING_SECRETS.telegram,
    MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN: PROVISIONING_SECRETS.linkedin,
    MESSAGING_BRIDGE_ALLOWED_HANDLES: "alice, bob",
    ...overrides,
  };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env as NodeJS.ProcessEnv;
}

export async function seedMachines(db: PlatformDB): Promise<void> {
  let index = 0;
  for (const owner of Object.values(OWNERS)) {
    index += 1;
    await insertUserMachine(db, {
      machineId: `machine_${owner.handle}`,
      clerkUserId: owner.ownerId,
      handle: owner.handle,
      runtimeSlot: "primary",
      status: "running",
      imageVersion: "v1",
      provisionedAt: `2026-11-0${index}T00:00:00.000Z`,
      activationState: "authorized",
    });
  }
}

export async function createHarness(db: PlatformDB, options: {
  env?: NodeJS.ProcessEnv;
  stepWaitMs?: number;
  now?: () => number;
} = {}) {
  const host = createFakeBridgeHost();
  const logs: string[] = [];
  const log = (...parts: unknown[]) => { logs.push(parts.map(part => typeof part === "string" ? part : JSON.stringify(part)).join(" ")); };
  const bridge = await createConfiguredMessagingBridge({
    env: options.env ?? bridgeEnv(),
    db,
    platformSecret: PLATFORM_SECRET,
    fetchImpl: host.fetchImpl,
    log: { warn: log, error: log },
    ...(options.stepWaitMs !== undefined ? { stepWaitMs: options.stepWaitMs } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const app = new Hono();
  app.route("/", bridge.routes);

  async function call(path: string, init: { method?: string; body?: unknown; handle?: string; token?: string | null } = {}) {
    const handle = init.handle ?? "alice";
    const headers: Record<string, string> = { "x-matrix-handle": handle };
    const token = init.token === undefined ? buildPlatformVerificationToken(handle, PLATFORM_SECRET) : init.token;
    if (token !== null) headers.authorization = `Bearer ${token}`;
    if (init.body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(`/internal/messaging-bridge${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, body: text ? JSON.parse(text) as any : undefined };
  }

  return { host, app, call, logs, shutdown: bridge.shutdown };
}
