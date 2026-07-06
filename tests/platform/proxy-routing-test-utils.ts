import { createHmac } from "node:crypto";
import { vi } from "vitest";
import type Dockerode from "dockerode";
import {
  type PlatformDB,
  insertContainer,
} from "../../packages/platform/src/db.js";
import type { Orchestrator } from "../../packages/platform/src/orchestrator.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "./platform-db-test-helper.js";

export const JWT_SECRET = "test-secret-at-least-32-characters-long";

export function expectedFallbackProvisionHandle(clerkUserId: string, secretKey = "sk_test_matrix"): string {
  return `u${createHmac("sha256", secretKey)
    .update(clerkUserId)
    .digest("hex")
    .slice(0, 12)}`;
}

export function stubOrchestrator(): Orchestrator {
  return {
    provision: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    destroy: vi.fn(),
    upgrade: vi.fn(),
    rollingRestart: vi.fn(),
    getInfo: vi.fn(async (handle: string) => ({
      handle,
      clerkUserId: "user_alice",
      containerId: "ctr-1",
      port: 5001,
      shellPort: 6001,
      status: "running",
    })),
    getImage: vi.fn(),
    listAll: vi.fn().mockResolvedValue([]),
    syncStates: vi.fn(),
  };
}

export function stubDocker(inspectInfo: { id?: string; ipAddress?: string; running?: boolean } = {}): Dockerode {
  const {
    id = "docker-ctr-1",
    ipAddress = "172.18.0.14",
    running = true,
  } = inspectInfo;
  return {
    getContainer: vi.fn(() => ({
      inspect: vi.fn().mockResolvedValue({
        Id: id,
        State: { Running: running },
        NetworkSettings: {
          Networks: {
            "matrixos-net": {
              IPAddress: ipAddress,
            },
          },
        },
      }),
    })),
  } as unknown as Dockerode;
}

export function combinedSetCookie(headers: Headers): string {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    return getSetCookie.call(headers).join("\n");
  }
  return headers.get("set-cookie") ?? "";
}

export function cookieHeaderFromSetCookie(headers: Headers, names: string[]): string {
  const raw = combinedSetCookie(headers);
  return names
    .map((name) => new RegExp(`(?:^|[\\n,]\\s*)(${name}=[^;,\\n]*)`).exec(raw)?.[1])
    .filter((value): value is string => Boolean(value))
    .join("; ");
}

export async function setupProxyRoutingTest(): Promise<PlatformDB> {
  process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED = "true";
  const { db } = await createTestPlatformDb();
  await insertContainer(db, {
    handle: "alice",
    clerkUserId: "user_alice",
    port: 5001,
    shellPort: 6001,
    status: "running",
  });
  return db;
}

export async function cleanupProxyRoutingTest(db: PlatformDB): Promise<void> {
  await destroyTestPlatformDb(db);
  vi.restoreAllMocks();
  delete process.env.PLATFORM_JWT_SECRET;
  delete process.env.MATRIX_PAID_BETA_ENTITLEMENT_STATUS;
  delete process.env.MATRIX_BILLING_PROVIDER;
  delete process.env.MATRIX_STRIPE_BILLING_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.HETZNER_SERVER_TYPE;
  delete process.env.MATRIX_LEGACY_CONTAINER_ROUTING_ENABLED;
  delete process.env.AUTH_SHELL_HOST;
  delete process.env.AUTH_SHELL_PORT;
}
