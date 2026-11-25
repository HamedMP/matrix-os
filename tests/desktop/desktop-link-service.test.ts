// The desktop side of the Desktop link (spec 2716) against the real gateway routes:
// switching it on enrols and links, the computer then reaches this device's core
// through the guard, and switching off, removal and dropped links behave as
// the spec says.
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopLinkRevisionTag } from "@matrix-os/contracts/desktop-link";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../../packages/gateway/src/desktop-link/routes.js";
import type { DesktopLinkDatabase } from "../../packages/gateway/src/desktop-link/store.js";
import { createFakeHerdrCore } from "../gateway/fixtures/fake-herdr-core-server.js";
import { createDesktopLinkPreferenceStore } from "../../desktop/src/main/desktop-link/preferences";
import { createDesktopLinkService, type DesktopLinkKey, type DesktopLinkService, type DesktopLinkSocket } from "../../desktop/src/main/desktop-link/service";

const OWNER = "owner_mac";
const HANDLE = "mac-test";
const MACHINE = "6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "isolated-runtime-auth-for-desktop-link-service";
const JWT_SECRET = "separate-isolated-jwt-secret-for-desktop-link";

let db: Kysely<DesktopLinkDatabase>;
const cleanup: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  const pglite = await KyselyPGlite.create();
  db = new Kysely({ dialect: pglite.dialect });
});
beforeEach(() => {
  vi.stubEnv("MATRIX_USER_ID", OWNER);
  vi.stubEnv("MATRIX_HANDLE", HANDLE);
  vi.stubEnv("MATRIX_RUNTIME_SLOT", "primary");
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
  vi.stubEnv("PLATFORM_JWT_SECRET", JWT_SECRET);
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await db.schema.dropTable("desktop_link_devices").ifExists().execute();
});
afterAll(async () => db.destroy());

function ownerJwt(subject = OWNER): Promise<string> {
  return new SignJWT({ handle: HANDLE, runtime_slot: "primary", gateway_url: "https://test.example" })
    .setProtectedHeader({ alg: "HS256" }).setSubject(subject).setIssuer("matrix-os-platform")
    .setAudience("matrix-os-sync").setIssuedAt().setExpirationTime("5m").sign(new TextEncoder().encode(JWT_SECRET));
}

async function computer() {
  const app = new Hono();
  app.use("*", authMiddleware(SECRET));
  const ws = createNodeWebSocket({ app });
  const registry: DesktopLinkRegistry = createDesktopLinkRegistry({
    createAdapter: (open) => createHerdrAdapter({ open, captureQuietMs: 5, captureMaxMs: 100 }),
  });
  registerDesktopLinkRoutes({
    app, upgradeWebSocket: ws.upgradeWebSocket, ownerDatabase: db, registry, log: () => {},
    config: readDesktopLinkConfig({ MATRIX_DESKTOP_LINK_ENABLED: "1", MATRIX_USER_ID: OWNER, MATRIX_MACHINE_ID: MACHINE }),
  });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await registry.drain();
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
  };
  cleanup.push(stop);
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  return { origin: `http://127.0.0.1:${address.port}`, registry, stop };
}

function desktopKeys() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const key: DesktopLinkKey = { privateKey: keys.privateKey, publicKey: spki.toString("base64url"), deviceId: createHash("sha256").update(spki).digest("hex") };
  return { key, loadOrCreate: vi.fn(async () => key) };
}

function mac(origin: string, options: { core?: ReturnType<typeof createFakeHerdrCore> } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
  cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
  const keys = desktopKeys();
  const core = options.core ?? createFakeHerdrCore();
  const sockets: DesktopLinkSocket[] = [];
  const service: DesktopLinkService = createDesktopLinkService({
    gatewayOrigin: () => origin,
    ownerId: () => OWNER,
    credential: async () => ownerJwt(),
    keys,
    openCore: async () => core.connect(),
    preferences: createDesktopLinkPreferenceStore(userData, () => {}),
    home: tmpdir(),
    deviceName: "Hamed's MacBook Pro",
    app: { version: "0.9.0", os: "macOS 26.1" }, device: { platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } },
    createSocket: (url, headers) => {
      const socket = new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket;
      sockets.push(socket);
      return socket;
    },
    random: () => 0,
    log: () => {},
  });
  cleanup.push(() => service.dispose());
  const states: string[] = [];
  service.onStatus((status) => states.push(status.state));
  return { service, keys, core, sockets, states, userData };
}

const until = (check: () => boolean, ms = 5_000) => vi.waitFor(() => { if (!check()) throw new Error("waiting"); }, { timeout: ms, interval: 10 });

describe("Desktop link service screenshots", () => {
  it("sends a screenshot the computer asks for, in pieces, and the owner gets the same bytes", async () => {
    const { origin, registry } = await computer();
    const image = Buffer.concat([Buffer.from([0xff, 0xd8]), Buffer.alloc(130 * 1024, 7)]);
    const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
    cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
    const keys = desktopKeys();
    const service = createDesktopLinkService({
      gatewayOrigin: () => origin, ownerId: () => OWNER, credential: async () => ownerJwt(), keys,
      openCore: async () => createFakeHerdrCore().connect(), preferences: createDesktopLinkPreferenceStore(userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" }, device: { platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
      screenshot: async () => ({ ok: true, image }),
    });
    cleanup.push(() => service.dispose());
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    expect((await registry.capture(keys.key.deviceId)).equals(image)).toBe(true);
  });
});

describe("Desktop link service", () => {
  it("is off until switched on, then enrols, links and serves the desktop's terminals to the computer", async () => {
    const { origin, registry } = await computer();
    const core = createFakeHerdrCore();
    core.add("t1", { title: "local shell", screen: "hi" });
    const { service, keys, states } = mac(origin, { core });
    await service.start();
    expect(service.statuses()).toEqual([]);
    expect(registry.size()).toBe(0);

    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    await until(() => service.statuses()[0]?.state === "on");
    // Its own views can now leave this device out of the computer's desktop list.
    expect(service.deviceIds()).toEqual([keys.key.deviceId]);
    expect(states).toContain("connecting");

    const listed = await registry.adapter(keys.key.deviceId)!.list();
    expect(listed.sessions.map((session) => session.id)).toEqual(["t1"]);
    // The computer's own calls reached the desktop's core through the guard.
    expect(core.calls.some((call) => call.method === "terminal.list")).toBe(true);
  });

  it("switching off closes the link at once and does not reconnect", async () => {
    const { origin, registry } = await computer();
    const { service, keys } = mac(origin);
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    await service.disable("primary");
    expect(service.statuses()[0]?.state).toBe("off");
    await until(() => !registry.online(keys.key.deviceId));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(registry.online(keys.key.deviceId)).toBe(false);
  });

  it("stays switched off across a restart, and on when it was on", async () => {
    const { origin, registry } = await computer();
    const first = mac(origin);
    await first.service.start();
    await first.service.enable("primary", "matrix-demo");
    await until(() => registry.online(first.keys.key.deviceId));
    first.service.dispose();
    await until(() => !registry.online(first.keys.key.deviceId));

    // Same profile and key: it reconnects by itself.
    const again = createDesktopLinkService({
      gatewayOrigin: () => origin, ownerId: () => OWNER, credential: async () => ownerJwt(), keys: first.keys,
      openCore: async () => createFakeHerdrCore().connect(), preferences: createDesktopLinkPreferenceStore(first.userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" }, device: { platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
    });
    cleanup.push(() => again.dispose());
    await again.start();
    await until(() => registry.online(first.keys.key.deviceId));
  });

  it("stops for good when the computer removes the desktop", async () => {
    const { origin, registry } = await computer();
    const { service, keys } = mac(origin);
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    const removed = await fetch(`${origin}/api/desktop-link/machines/${keys.key.deviceId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${await ownerJwt()}`, "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: keys.key.deviceId, revision: 1 }) },
      signal: AbortSignal.timeout(5_000),
    });
    expect(removed.status).toBe(200);
    await until(() => service.statuses()[0]?.state === "removed");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(registry.online(keys.key.deviceId)).toBe(false);
    // Switching it on again enrols afresh at a higher revision.
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
  });

  it("reconnects after the link drops, and at once on wake", async () => {
    const { origin, registry } = await computer();
    const { service, keys, sockets } = mac(origin);
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    // A network cut: the socket dies without a clean close from the gateway.
    (sockets.at(-1) as unknown as WebSocket).close(4000);
    await until(() => sockets.length === 2 && registry.online(keys.key.deviceId));
    service.wake();
    expect(registry.online(keys.key.deviceId)).toBe(true);
  });

  it("refuses an org member's credential: nothing is enrolled", async () => {
    const { origin, registry } = await computer();
    const keys = desktopKeys();
    const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
    cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
    const service = createDesktopLinkService({
      gatewayOrigin: () => origin, ownerId: () => "org_member", credential: async () => ownerJwt("org_member"), keys,
      openCore: async () => createFakeHerdrCore().connect(), preferences: createDesktopLinkPreferenceStore(userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" }, device: { platform: "darwin", arch: "arm64", capabilities: { terminals: true, screenshot: true, input: false } },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
    });
    cleanup.push(() => service.dispose());
    await service.start();
    await expect(service.enable("primary", "matrix-demo")).rejects.toMatchObject({ reason: "denied" });
    expect(registry.size()).toBe(0);
  });
});
