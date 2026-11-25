import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MessagingBridgeErrorSchema,
  MessagingBridgeSessionSchema,
} from "@matrix-os/contracts/messaging-bridge";
import type { PlatformDB } from "../../../packages/platform/src/db.js";
import { insertUserMachine } from "../../../packages/platform/src/db.js";
import { createApp } from "../../../packages/platform/src/main.js";
import { createDisabledOrchestrator } from "../../../packages/platform/src/orchestrator.js";
import { buildPlatformVerificationToken } from "../../../packages/platform/src/platform-token.js";
import { createTestPlatformDb, destroyTestPlatformDb } from "../native-platform-db-test-helper.js";
import { ADMIN_TOKEN, APPSERVICE_TOKEN, GATE_SECRET, HOST_URL, PROVISIONING_SECRETS, SERVER_NAME, installSynapseAdmin, json } from "./fake-bridge-host.js";
import { OWNERS, PLATFORM_SECRET, USER_ID_KEY, bridgeEnv, createHarness, seedMachines } from "./harness.js";

function expectedUserId(ownerId: string, key = USER_ID_KEY): string {
  return `@mxo_${createHmac("sha256", key).update(ownerId).digest("hex").slice(0, 32)}:${SERVER_NAME}`;
}

async function identityRows(db: PlatformDB) {
  return db.kysely.selectFrom("messaging_bridge_identities" as never).selectAll().execute() as Promise<Array<{ owner_id: string; matrix_user_id: string }>>;
}

describe("messaging bridge platform routes: access and session", () => {
  let db: PlatformDB;
  const shutdowns: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    ({ db } = await createTestPlatformDb());
    await seedMachines(db);
  });

  afterEach(async () => {
    for (const shutdown of shutdowns.splice(0)) await shutdown();
    await destroyTestPlatformDb(db);
  });

  async function harness(options: Parameters<typeof createHarness>[1] = {}) {
    const created = await createHarness(db, options);
    shutdowns.push(created.shutdown);
    return created;
  }

  describe("machine credential", () => {
    it.each([
      ["no credential", { token: null }],
      ["a wrong token", { token: "0".repeat(64) }],
      ["another handle's token", { token: createHmac("sha256", PLATFORM_SECRET).update("bob").digest("hex") }],
    ])("rejects %s with 401 unauthorized and never reaches the bridge host", async (_label, init) => {
      const { call, host } = await harness();
      installSynapseAdmin(host);
      const response = await call("/session", { method: "POST", ...init });
      expect(response.status).toBe(401);
      expect(MessagingBridgeErrorSchema.parse(response.body).error.code).toBe("unauthorized");
      expect(host.requests).toHaveLength(0);
    });

    it("rejects a handle whose machine is not running", async () => {
      const { call, host } = await harness();
      const response = await call("/session", { method: "POST", handle: "nobody" });
      expect(response.status).toBe(401);
      expect(host.requests).toHaveLength(0);
    });

    it("rejects a preview machine that shares the bearer derivation", async () => {
      await insertUserMachine(db, {
        machineId: "machine_preview",
        clerkUserId: "user_preview",
        handle: "pr-42",
        runtimeSlot: "pr-42",
        provisioningClass: "preview",
        status: "running",
        provisionedAt: "2026-11-10T00:00:00.000Z",
        activationState: "authorized",
      });
      const { call } = await harness({ env: bridgeEnv({ MESSAGING_BRIDGE_ALLOWED_HANDLES: "alice,pr-42" }) });
      const response = await call("/session", { method: "POST", handle: "pr-42" });
      expect(response.status).toBe(401);
    });

    it("answers 403 not_enabled for an authenticated owner outside the allowlist", async () => {
      const { call, host } = await harness();
      for (const path of ["/session", "/whatsapp/login/start"]) {
        const response = await call(path, { method: "POST", handle: "carol", body: {} });
        expect(response.status).toBe(403);
        expect(response.body).toEqual({ error: { code: "not_enabled", message: expect.any(String) } });
      }
      expect((await call("/telegram/logins", { handle: "carol" })).status).toBe(403);
      expect(host.requests).toHaveLength(0);
    });
  });

  it("is mounted on the platform app ahead of tenant session routing and admin auth", async () => {
    const { host, shutdown } = await createHarness(db);
    shutdowns.push(shutdown);
    installSynapseAdmin(host);
    const { createConfiguredMessagingBridge } = await import("../../../packages/platform/src/messaging-bridge/startup.js");
    const bridge = await createConfiguredMessagingBridge({ env: bridgeEnv(), db, platformSecret: PLATFORM_SECRET, fetchImpl: host.fetchImpl });
    shutdowns.push(bridge.shutdown);
    const platform = createApp({
      db,
      platformSecret: PLATFORM_SECRET,
      orchestrator: createDisabledOrchestrator({ db, image: "test" }),
      messagingBridgeRoutes: bridge.routes,
    });
    const response = await platform.request("/internal/messaging-bridge/session", {
      method: "POST",
      headers: { "x-matrix-handle": "alice", authorization: `Bearer ${buildPlatformVerificationToken("alice", PLATFORM_SECRET)}` },
    });
    expect(response.status).toBe(200);
    expect(MessagingBridgeSessionSchema.parse(await response.json()).userId).toBe(expectedUserId(OWNERS.alice.ownerId));
  });

  describe("misconfiguration is 503, never 404", () => {
    it.each([
      ["missing host URL", { MESSAGING_BRIDGE_HOST_URL: undefined }],
      ["missing admin token", { MESSAGING_BRIDGE_ADMIN_TOKEN: undefined }],
      ["missing appservice token", { MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN: undefined }],
      ["a plain-http host URL", { MESSAGING_BRIDGE_HOST_URL: "http://bridge.example.test" }],
      ["missing user id key", { MESSAGING_BRIDGE_USER_ID_KEY: undefined }],
    ])("%s answers misconfigured on every route", async (_label, overrides) => {
      const { call, host } = await harness({ env: bridgeEnv(overrides) });
      const responses = [
        await call("/session", { method: "POST" }),
        await call("/whatsapp/login/flows"),
        await call("/whatsapp/login/start", { method: "POST", body: {} }),
        await call("/whatsapp/login/step", { method: "POST", body: { loginProcessId: "p1", stepId: "s1" } }),
        await call("/whatsapp/logins"),
        await call("/whatsapp/logout", { method: "POST", body: { loginId: "l1" } }),
      ];
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(MessagingBridgeErrorSchema.parse(response.body).error.code).toBe("misconfigured");
      }
      expect(host.requests).toHaveLength(0);
    });

    it("runs from the bridge host's platform.env plus only the platform-managed allowlist", async () => {
      // Exactly the keys distro/messaging-bridge-host/bootstrap.sh writes to platform.env.
      const hostOnly = bridgeEnv({ MESSAGING_BRIDGE_ALLOWED_HANDLES: undefined });
      expect(Object.keys(hostOnly).sort()).toEqual([
        "MESSAGING_BRIDGE_ADMIN_TOKEN", "MESSAGING_BRIDGE_DOUBLEPUPPET_AS_TOKEN", "MESSAGING_BRIDGE_GATE_SECRET",
        "MESSAGING_BRIDGE_HOST_URL", "MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN", "MESSAGING_BRIDGE_PROVISIONING_SECRET_TELEGRAM",
        "MESSAGING_BRIDGE_PROVISIONING_SECRET_WHATSAPP", "MESSAGING_BRIDGE_SERVER_NAME", "MESSAGING_BRIDGE_USER_ID_KEY",
      ]);
      const noAllowlist = await harness({ env: hostOnly });
      expect((await noAllowlist.call("/session", { method: "POST" })).body.error.code).toBe("not_enabled");
      const allowlisted = await harness({ env: { ...hostOnly, MESSAGING_BRIDGE_ALLOWED_HANDLES: "alice" } });
      installSynapseAdmin(allowlisted.host);
      expect((await allowlisted.call("/session", { method: "POST" })).status).toBe(200);
    });

    it("omits a network without a provisioning secret and answers 503 on its routes", async () => {
      const { call, host } = await harness({ env: bridgeEnv({ MESSAGING_BRIDGE_PROVISIONING_SECRET_LINKEDIN: undefined }) });
      installSynapseAdmin(host);
      const session = await call("/session", { method: "POST" });
      expect(session.status).toBe(200);
      expect(session.body.networks).toEqual(["whatsapp", "telegram"]);
      const flows = await call("/linkedin/login/flows");
      expect(flows.status).toBe(503);
      expect(flows.body.error.code).toBe("misconfigured");
    });
  });

  describe("POST /session", () => {
    it("ensures the derived homeserver user, mints its token, and never stores or logs the token", async () => {
      const token = "syt_owner_token_value_0123456789abcdef";
      const { call, host, logs } = await harness({ now: () => Date.parse("2026-11-22T00:00:00.000Z") });
      installSynapseAdmin(host, [token]);

      const response = await call("/session", { method: "POST" });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const session = MessagingBridgeSessionSchema.parse(response.body);
      const userId = expectedUserId(OWNERS.alice.ownerId);
      expect(session).toEqual({
        homeserverUrl: HOST_URL,
        userId,
        accessToken: token,
        deviceId: "MATRIXOS_GATEWAY",
        networks: ["whatsapp", "telegram", "linkedin"],
      });

      const [ensure, login] = host.requests;
      expect(ensure.method).toBe("PUT");
      expect(ensure.url.href).toBe(`${HOST_URL}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`);
      expect(ensure.headers.get("authorization")).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(ensure.headers.get("x-matrix-bridge-gate")).toBe(GATE_SECRET);
      expect(ensure.body).toEqual({ admin: false });
      expect(login.method).toBe("POST");
      expect(login.url.href).toBe(`${HOST_URL}/_matrix/client/v3/login`);
      expect(login.headers.get("authorization")).toBe(`Bearer ${APPSERVICE_TOKEN}`);
      expect(login.body).toEqual({
        type: "m.login.application_service",
        identifier: { type: "m.id.user", user: userId },
        device_id: "MATRIXOS_GATEWAY",
        initial_device_display_name: "Matrix OS",
      });

      expect(await identityRows(db)).toEqual([expect.objectContaining({ owner_id: OWNERS.alice.ownerId, matrix_user_id: userId })]);
      const persisted = JSON.stringify(await db.kysely.selectFrom("messaging_bridge_identities" as never).selectAll().execute());
      expect(persisted).not.toContain(token);
      expect(logs.join("\n")).not.toContain(token);
    });

    it("is idempotent: repeated and concurrent sessions keep one identity and one device per owner", async () => {
      const { call, host } = await harness();
      const synapse = installSynapseAdmin(host);
      const results = await Promise.all([
        call("/session", { method: "POST" }),
        call("/session", { method: "POST" }),
        call("/session", { method: "POST", handle: "bob" }),
      ]);
      const again = await call("/session", { method: "POST" });
      expect(results.map(result => result.status)).toEqual([200, 200, 200]);
      expect(again.body.userId).toBe(results[0].body.userId);
      expect(results[2].body.userId).toBe(expectedUserId(OWNERS.bob.ownerId));
      // Fresh tokens, but every alice session lands on the same device, so send txn ids stay deduplicated.
      expect(new Set([results[0], results[1], again].map(result => result.body.accessToken)).size).toBe(3);
      expect([results[0], results[1], again].map(result => result.body.deviceId)).toEqual(["MATRIXOS_GATEWAY", "MATRIXOS_GATEWAY", "MATRIXOS_GATEWAY"]);
      expect([...synapse.devices].sort()).toEqual([
        `${expectedUserId(OWNERS.alice.ownerId)}|MATRIXOS_GATEWAY`,
        `${expectedUserId(OWNERS.bob.ownerId)}|MATRIXOS_GATEWAY`,
      ].sort());
      const rows = await identityRows(db);
      expect(rows.map(row => row.owner_id).sort()).toEqual([OWNERS.alice.ownerId, OWNERS.bob.ownerId]);
    });

    it("keeps the persisted identity when the derivation key later changes", async () => {
      const first = await harness();
      installSynapseAdmin(first.host);
      const original = (await first.call("/session", { method: "POST" })).body.userId;
      const rotated = await harness({ env: bridgeEnv({ MESSAGING_BRIDGE_USER_ID_KEY: "rotated-key-0123456789abcdef0123456789" }) });
      installSynapseAdmin(rotated.host);
      const response = await rotated.call("/session", { method: "POST" });
      expect(response.body.userId).toBe(original);
    });

    it("maps homeserver failures to fixed error bodies without leaking provider detail", async () => {
      const { call, host, logs } = await harness();
      host.on("PUT", /^\/_synapse\/admin\/v2\/users\//, () => json({ errcode: "M_UNKNOWN", error: `db down ${ADMIN_TOKEN}` }, 500));
      const failed = await call("/session", { method: "POST" });
      expect(failed.status).toBe(502);
      expect(failed.body.error.code).toBe("bridge_unavailable");
      expect(failed.text).not.toMatch(/synapse|db down|admin/i);
      expect(logs.join("\n")).not.toContain(ADMIN_TOKEN);

      host.on("PUT", /^\/_synapse\/admin\/v2\/users\//, () => json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid token" }, 401));
      const rejected = await call("/session", { method: "POST" });
      expect(rejected.status).toBe(503);
      expect(rejected.body.error.code).toBe("misconfigured");
    });

    it("treats a transport failure or timeout as bridge_unavailable", async () => {
      const { call, host } = await harness();
      host.on("PUT", /^\/_synapse\/admin\/v2\/users\//, () => { throw new DOMException("The operation timed out.", "TimeoutError"); });
      const response = await call("/session", { method: "POST" });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe("bridge_unavailable");
    });

    it("does not send provisioning secrets to the homeserver admin API", async () => {
      const { call, host } = await harness();
      installSynapseAdmin(host);
      await call("/session", { method: "POST" });
      const sent = host.requests.map(request => [...request.headers.values()].join(" ")).join(" ");
      for (const secret of Object.values(PROVISIONING_SECRETS)) expect(sent).not.toContain(secret);
    });
  });
});
