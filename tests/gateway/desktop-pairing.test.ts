import { createHash, createHmac, generateKeyPairSync, sign } from "node:crypto";
import {
  desktopPairingProofMessage, DesktopPairingChallengeSchema,
} from "@matrix-os/contracts";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAllowedOriginController } from "../../packages/gateway/src/allowed-origins.js";
import type { DesktopPairingDatabase } from "../../packages/gateway/src/desktop-pairing/database.js";
import { createRuntimeDesktopPairingRoutes } from "../../packages/gateway/src/desktop-pairing/routes.js";
import { registerGatewayAccessMiddleware } from "../../packages/gateway/src/server/access-middleware.js";

const path = "/api/desktop-pairing";
const owner = "owner_test";
const handle = "isolated-test";
const machineId = "11805f32-14cd-4651-85b0-675c80a65812";
const secondMachine = "4d6cd449-48d2-4946-95a1-3b4d188eec35";
const platformSecret = "isolated-runtime-auth-for-pairing-tests";
const jwtSecret = "separate-isolated-test-jwt-signing-secret";
const shellOrigin = "https://shell.example";

function testDevice() {
  const keys = generateKeyPairSync("ed25519");
  const bytes = keys.publicKey.export({ format: "der", type: "spki" });
  const deviceId = createHash("sha256").update(bytes).digest("hex");
  return {
    deviceId,
    complete(challenge: { machineId: string; revision: number; nonce: string }, ownerId = owner) {
      return {
        nonce: challenge.nonce,
        publicKey: bytes.toString("base64url"),
        signature: sign(null, Buffer.from(desktopPairingProofMessage({
          ownerId, machineId: challenge.machineId, deviceId, revision: challenge.revision, nonce: challenge.nonce,
        })), keys.privateKey).toString("base64url"),
      };
    },
  };
}

function platformOwnerHeaders(userId = owner): HeadersInit {
  return {
    authorization: `Bearer ${platformSecret}`,
    "x-platform-user-id": userId,
    "x-platform-verified": createHmac("sha256", platformSecret).update(userId).digest("hex"),
  };
}

function revocationHeaders(computer: string, deviceId: string, revision: number, userId = owner) {
  return new Headers({
    ...platformOwnerHeaders(userId),
    "If-Match": `"desktop-pairing-${computer}-${deviceId}-${revision}"`,
  });
}

describe("Desktop pairing routes behind Gateway authentication", () => {
  let now: number;
  let db: Kysely<DesktopPairingDatabase>;

  beforeAll(async () => {
    const pglite = await KyselyPGlite.create();
    db = new Kysely({ dialect: pglite.dialect });
  });

  beforeEach(() => {
    vi.stubEnv("MATRIX_HANDLE", handle);
    vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
    vi.stubEnv("MATRIX_USER_ID", owner);
    vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
    vi.stubEnv("PLATFORM_JWT_SECRET", jwtSecret);
    now = 1_700_000_000_000;
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await db.schema.dropTable("desktop_pairings").ifExists().execute();
  });

  afterAll(async () => db.destroy());

  async function gateway(env: NodeJS.ProcessEnv = {}, ownerDatabase: Kysely<DesktopPairingDatabase> | null = db) {
    const app = new Hono();
    registerGatewayAccessMiddleware(app, {
      resolveAllowedOrigin: createAllowedOriginController({ shellOrigin }).resolve,
      devAppAuthBypass: false,
      authToken: platformSecret,
      auth: { resolveMatrixMcpCapability: (token) => token === "scoped-harness-token" ? owner : null },
    });
    app.route(path, await createRuntimeDesktopPairingRoutes({
      ownerDatabase, now: () => now,
      env: { MATRIX_DESKTOP_PAIRING_ENABLED: "1", MATRIX_MACHINE_ID: machineId,
        MATRIX_HANDLE: handle, MATRIX_RUNTIME_SLOT: "primary", MATRIX_USER_ID: owner, ...env },
    }));
    const raw = (suffix: string, method: string, body?: string, auth: HeadersInit = platformOwnerHeaders()) => {
      const headers = new Headers(auth);
      if (body !== undefined) headers.set("content-type", "application/json");
      return app.request(path + suffix, { method, headers, body });
    };
    const request = (suffix = "", method = "GET", body?: unknown, auth?: HeadersInit) =>
      raw(suffix, method, body === undefined ? undefined : JSON.stringify(body), auth);
    return Object.assign(request, { raw, app });
  }

  async function challenge(
    request: Awaited<ReturnType<typeof gateway>>, deviceId: string, revision = 0,
  ) {
    const response = await request("/challenge", "POST", { deviceId, revision });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    return DesktopPairingChallengeSchema.parse(await response.json());
  }

  it("scopes an authenticated status to the host owner and accepts a Matrix JWT", async () => {
    const request = await gateway();
    expect((await request("", "GET", undefined, {})).status).toBe(401);
    expect((await request("", "GET", undefined, { authorization: `Bearer ${platformSecret}` })).status).toBe(403);
    expect((await request("", "GET", undefined, { authorization: "Bearer scoped-harness-token" })).status).toBe(403);
    expect((await request("", "GET", undefined, platformOwnerHeaders("other_owner"))).status).toBe(403);
    const jwt = await new SignJWT({ handle, runtime_slot: "primary", gateway_url: "https://test.example" })
      .setProtectedHeader({ alg: "HS256" }).setSubject(owner).setIssuer("matrix-os-platform")
      .setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(jwtSecret));
    const response = await request("", "GET", undefined, { authorization: `Bearer ${jwt}` });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ machineId, deviceId: null, revision: 0 });
  });

  it("allows first-party preflight, secures auth failures and fences private routine routes before handlers", async () => {
    const { app } = await gateway();
    app.get("/api/chats/:chatId", c => c.json({ visible: true }));
    const preflight = await app.request(path, {
      method: "OPTIONS",
      headers: { Origin: shellOrigin, "Access-Control-Request-Method": "GET" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe(shellOrigin);

    const hiddenChatPath = "/api/chats/chat_routine_0123456789abcdef0123456789abcdef";
    const unauthenticated = await app.request(hiddenChatPath, { headers: { Origin: shellOrigin } });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("Access-Control-Allow-Origin")).toBe(shellOrigin);
    expect(unauthenticated.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const auth = { headers: platformOwnerHeaders() };
    expect((await app.request(hiddenChatPath, auth)).status).toBe(404);
    expect((await app.request("/api/chats/chat_visible", auth)).status).toBe(200);
  });

  it("is unavailable outside an enabled primary Computer with a valid UUID and owner database", async () => {
    expect((await (await gateway({ MATRIX_DESKTOP_PAIRING_ENABLED: undefined }))()).status).toBe(404);
    expect((await (await gateway({ MATRIX_RUNTIME_SLOT: "pr-41" }))()).status).toBe(503);
    expect((await (await gateway({ MATRIX_MACHINE_ID: "unknown" }))()).status).toBe(503);
    expect((await (await gateway({}, null))()).status).toBe(503);
  });

  it("persists the binding and revocation across new Gateway lifecycles", async () => {
    const device = testDevice();
    const request = await gateway();
    const pending = await challenge(request, device.deviceId);
    const paired = await request("/pair", "POST", device.complete(pending));
    expect(paired.status).toBe(200);
    await expect(paired.json()).resolves.toEqual({ machineId, deviceId: device.deviceId, revision: 1 });
    expect((await request("/pair", "POST", device.complete(pending))).status).toBe(409);

    const restarted = await gateway();
    await expect((await restarted()).json()).resolves.toEqual({ machineId, deviceId: device.deviceId, revision: 1 });
    expect((await restarted("/challenge", "POST", { deviceId: testDevice().deviceId, revision: 1 })).status).toBe(409);
    expect((await restarted(`/${device.deviceId}`, "DELETE", { revision: 0 }, revocationHeaders(machineId, device.deviceId, 0))).status).toBe(409);
    expect((await restarted(`/${device.deviceId}`, "DELETE", { revision: 1 }, platformOwnerHeaders("other_owner"))).status).toBe(403);
    const revoked = await restarted(`/${device.deviceId}`, "DELETE", { revision: 1 }, revocationHeaders(machineId, device.deviceId, 1));
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({ machineId, deviceId: null, revision: 2 });

    const afterRevoke = await gateway();
    await expect((await afterRevoke()).json()).resolves.toEqual({ machineId, deviceId: null, revision: 2 });
    expect((await afterRevoke("/challenge", "POST", { deviceId: device.deviceId, revision: 0 })).status).toBe(409);
    const fresh = await challenge(afterRevoke, device.deviceId, 2);
    await expect((await afterRevoke("/pair", "POST", device.complete(fresh))).json())
      .resolves.toEqual({ machineId, deviceId: device.deviceId, revision: 3 });
    expect((await afterRevoke(`/${device.deviceId}`, "DELETE", { revision: 1 }, revocationHeaders(machineId, device.deviceId, 1))).status).toBe(409);
  });

  it("rejects an absent or stale Computer fence even for the same owner, device and revision", async () => {
    const device = testDevice();
    const firstComputer = await gateway();
    const replacement = await gateway({ MATRIX_MACHINE_ID: secondMachine });
    for (const current of [firstComputer, replacement]) {
      const proof = device.complete(await challenge(current, device.deviceId));
      expect((await current("/pair", "POST", proof)).status).toBe(200);
    }
    const target = `/${device.deviceId}`;
    expect((await replacement(target, "DELETE", { revision: 1 })).status).toBe(412);
    expect((await replacement(target, "DELETE", { revision: 1 },
      revocationHeaders(machineId, device.deviceId, 1))).status).toBe(412);
    await expect((await replacement()).json()).resolves.toEqual({ machineId: secondMachine, deviceId: device.deviceId, revision: 1 });
    expect((await replacement(target, "DELETE", { revision: 1 },
      revocationHeaders(secondMachine, device.deviceId, 1))).status).toBe(200);
    await expect((await firstComputer()).json()).resolves.toEqual({ machineId, deviceId: device.deviceId, revision: 1 });
  });

  it("rejects expired proof, a proof on another Computer, and an outstanding challenge after restart", async () => {
    const device = testDevice();
    const request = await gateway();
    const pending = await challenge(request, device.deviceId);
    const proof = device.complete(pending);
    const elsewhere = await gateway({ MATRIX_MACHINE_ID: secondMachine });
    expect((await elsewhere("/pair", "POST", proof)).status).toBe(409);
    expect((await (await gateway())("/pair", "POST", proof)).status).toBe(409);
    now = pending.expiresAt;
    expect((await request("/pair", "POST", proof)).status).toBe(409);
    await expect((await request()).json()).resolves.toEqual({ machineId, deviceId: null, revision: 0 });
  });

  it("consumes rejected proof and refuses identity or Computer substitution in the signed message", async () => {
    const device = testDevice();
    const request = await gateway();
    const pending = await challenge(request, device.deviceId);
    expect((await request("/pair", "POST", testDevice().complete(pending))).status).toBe(409);
    expect((await request("/pair", "POST", device.complete(pending))).status).toBe(409);
    const otherComputer = await challenge(request, device.deviceId);
    expect((await request("/pair", "POST", device.complete({ ...otherComputer, machineId: secondMachine }))).status).toBe(409);
    const otherOwner = await challenge(request, device.deviceId);
    expect((await request("/pair", "POST", device.complete(otherOwner, "other_owner"))).status).toBe(409);
  });

  it("allows exactly one concurrent claimant and fences pre-revocation challenges", async () => {
    const macA = testDevice();
    const macB = testDevice();
    const request = await gateway();
    const first = await challenge(request, macA.deviceId);
    const simultaneous = await challenge(request, macB.deviceId);
    const delayed = await challenge(request, macB.deviceId);
    const requests = await Promise.all([
      request("/pair", "POST", macA.complete(first)),
      request("/pair", "POST", macB.complete(simultaneous)),
    ]);
    expect(requests.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = await requests.find(response => response.ok)!.json() as { deviceId: string };
    expect((await request(`/${winner.deviceId}`, "DELETE", { revision: 1 }, revocationHeaders(machineId, winner.deviceId, 1))).status).toBe(200);
    expect((await request("/pair", "POST", macB.complete(delayed))).status).toBe(409);
  });

  it("bounds pending challenges and preserves only recent challenges when full", async () => {
    const device = testDevice();
    const request = await gateway();
    const oldest = await challenge(request, device.deviceId);
    for (let index = 0; index < 15; index++) await challenge(request, device.deviceId);
    const current = await challenge(request, device.deviceId);
    expect((await request("/pair", "POST", device.complete(oldest))).status).toBe(409);
    expect((await request("/pair", "POST", device.complete(current))).status).toBe(200);
  });

  it("rejects unexpected fields, malformed JSON, route parameters, and oversized mutation bodies", async () => {
    const request = await gateway();
    expect((await request("/challenge", "POST", { ownerId: owner, deviceId: "a".repeat(64), revision: 0 })).status).toBe(400);
    expect((await request.raw("/challenge", "POST", "{")).status).toBe(400);
    expect((await request("/not-a-fingerprint", "DELETE", { revision: 0 })).status).toBe(400);
    expect((await request(`/${"a".repeat(64)}`, "DELETE", { revision: 0, extra: "x".repeat(8000) })).status).toBe(413);
  });

  it("keeps device enrollment available without exposing the retired Mac Chat action endpoints", async () => {
    const request = await gateway();
    const mac = testDevice();
    const enrollment = await challenge(request, mac.deviceId);
    expect((await request("/pair", "POST", mac.complete(enrollment))).status).toBe(200);
    expect((await request("/action-challenge", "POST", { deviceId: mac.deviceId, revision: 1 })).status).toBe(404);
    expect((await request("/verify-action", "POST", {})).status).toBe(404);
  });
});
