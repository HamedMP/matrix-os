// The desktop side of the desktop link (spec 2716) against the real gateway routes,
// including 2698's pairing routes: nothing links before the device is paired,
// then the computer reaches this device's core through the guard, and switching
// off, removal (a pairing disconnect) and dropped links behave as the spec says.
import { once } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { SignJWT } from "jose";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopPairingChallengeSchema, DesktopPairingStateSchema, desktopPairingProofMessage, desktopPairingRevisionTag } from "@matrix-os/contracts";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../../packages/gateway/src/desktop-link/routes.js";
import type { DesktopPairingDatabase } from "../../packages/gateway/src/desktop-pairing/database.js";
import { createRuntimeDesktopPairingRoutes } from "../../packages/gateway/src/desktop-pairing/routes.js";
import { createFakeHerdrCore } from "../gateway/fixtures/fake-herdr-core-server.js";
import { createDesktopLinkPreferenceStore } from "../../desktop/src/main/desktop-link/preferences";
import { createDesktopLinkService, type DesktopLinkService, type DesktopLinkServiceOptions, type DesktopLinkSocket } from "../../desktop/src/main/desktop-link/service";

const OWNER = "owner_mac";
const HANDLE = "mac-test";
const MACHINE = "6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "isolated-runtime-auth-for-desktop-link-service";
const JWT_SECRET = "separate-isolated-jwt-secret-for-desktop-link";
/** These cases are about the link itself: the owner approves everything (consent has its own tests). */
const ALLOW_ALL = { ask: async () => true, fullAccess: async () => false };

let db: Kysely<DesktopPairingDatabase>;
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
  await db.schema.dropTable("desktop_pairings").ifExists().execute();
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
  const env = {
    MATRIX_DESKTOP_PAIRING_ENABLED: "1", MATRIX_DESKTOP_LINK_ENABLED: "1", MATRIX_USER_ID: OWNER, MATRIX_MACHINE_ID: MACHINE,
    MATRIX_HANDLE: HANDLE, MATRIX_RUNTIME_SLOT: "primary",
  };
  app.route("/api/desktop-pairing", await createRuntimeDesktopPairingRoutes({
    ownerDatabase: db, env, onPairingChanged: (state) => registry.pairingChanged(state),
  }));
  registerDesktopLinkRoutes({ app, upgradeWebSocket: ws.upgradeWebSocket, ownerDatabase: db, registry, log: () => {}, config: readDesktopLinkConfig(env) });
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
  return { privateKey: keys.privateKey, publicKey: spki.toString("base64url"), deviceId: createHash("sha256").update(spki).digest("hex") };
}

/**
 * This device's 2698 pairing against the computer's real pairing routes: pair and
 * disconnect as the dialog would, and the link identity read from the gateway's
 * current pairing (as `createDesktopPairing().linkIdentity` does over HTTPS).
 */
function testPairing(origin: string, key: { privateKey: KeyObject; publicKey: string; deviceId: string } = desktopKeys(), subject = OWNER) {
  const call = async (path: string, init: RequestInit = {}) => fetch(`${origin}/api/desktop-pairing${path}`, {
    ...init, signal: AbortSignal.timeout(5_000),
    headers: { Authorization: `Bearer ${await ownerJwt(subject)}`, "content-type": "application/json", ...(init.headers as Record<string, string> ?? {}) },
  });
  const read = async () => DesktopPairingStateSchema.parse(await (await call("")).json());
  return {
    key,
    async pair(): Promise<number> {
      const { revision } = await read();
      const challenge = DesktopPairingChallengeSchema.parse(await (await call("/challenge", { method: "POST", body: JSON.stringify({ deviceId: key.deviceId, revision }) })).json());
      const signature = sign(null, Buffer.from(desktopPairingProofMessage({ ownerId: subject, machineId: MACHINE, deviceId: key.deviceId, revision, nonce: challenge.nonce })), key.privateKey).toString("base64url");
      const paired = await call("/pair", { method: "POST", body: JSON.stringify({ nonce: challenge.nonce, publicKey: key.publicKey, signature }) });
      expect(paired.status).toBe(200);
      return revision + 1;
    },
    async unpair(): Promise<Response> {
      const { revision } = await read();
      return call(`/${key.deviceId}`, {
        method: "DELETE", body: JSON.stringify({ revision }),
        headers: { "If-Match": desktopPairingRevisionTag({ machineId: MACHINE, deviceId: key.deviceId, revision }) },
      });
    },
    linkIdentity: vi.fn(async () => {
      const response = await call("");
      if (!response.ok) throw new Error("pairing unavailable");
      const state = DesktopPairingStateSchema.parse(await response.json());
      return state.deviceId === key.deviceId
        ? { origin, ownerId: subject, machineId: state.machineId, deviceId: key.deviceId, revision: state.revision, privateKey: key.privateKey }
        : null;
    }),
  };
}

function mac(origin: string, options: { core?: ReturnType<typeof createFakeHerdrCore>; readInventory?: DesktopLinkServiceOptions["readInventory"] } = {}) {
  const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
  cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
  const pairing = testPairing(origin);
  const keys = { key: pairing.key };
  const core = options.core ?? createFakeHerdrCore();
  const sockets: DesktopLinkSocket[] = [];
  const service: DesktopLinkService = createDesktopLinkService({
    pairing,
    credential: async () => ownerJwt(),
    consent: ALLOW_ALL,
    openCore: async () => core.connect(),
    readInventory: options.readInventory,
    preferences: createDesktopLinkPreferenceStore(userData, () => {}),
    home: tmpdir(),
    deviceName: "Hamed's MacBook Pro",
    app: { version: "0.9.0", os: "macOS 26.1" },
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
  return { service, keys, pairing, core, sockets, states, userData };
}

const until = (check: () => boolean, ms = 5_000) => vi.waitFor(() => { if (!check()) throw new Error("waiting"); }, { timeout: ms, interval: 10 });

describe("Desktop link service", () => {
  it("links nothing before this device is paired, then links and serves the desktop's terminals to the computer", async () => {
    const { origin, registry } = await computer();
    const core = createFakeHerdrCore();
    core.add("t1", { title: "local shell", screen: "hi" });
    const { service, keys, pairing, states } = mac(origin, { core });
    await service.start();
    expect(service.statuses()).toEqual([]);
    await expect(service.enable("primary", "matrix-demo")).rejects.toMatchObject({ reason: "not_paired" });
    // Only the primary computer pairs with a desktop.
    await expect(service.enable("dev", "matrix-dev")).rejects.toMatchObject({ reason: "denied" });
    expect(registry.size()).toBe(0);

    await pairing.pair();
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

  it("sends only the paired owner's inventory after admission and clears it on Stop", async () => {
    const gateway = await computer();
    const machines = [{ name: "independent-mac", state: "unreachable" as const }];
    const readInventory = vi.fn(async () => ({ machines, partial: true }));
    const desktop = mac(gateway.origin, { readInventory });
    await desktop.service.start();
    expect(readInventory).not.toHaveBeenCalled();
    await desktop.pairing.pair();
    await desktop.service.enable("primary", "matrix-demo");
    await until(() => gateway.registry.linked()[0]?.herdrMachines?.[0]?.name === "independent-mac");
    expect(readInventory.mock.calls).toEqual([[OWNER]]);
    expect(gateway.registry.linked()[0]).toMatchObject({ herdrMachines: machines, herdrMachinesPartial: true });
    await desktop.service.disable("primary");
    await until(() => gateway.registry.linked().length === 0);
  });

  it("switching off closes the link at once and does not reconnect", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing } = mac(origin);
    await pairing.pair();
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
    await first.pairing.pair();
    await first.service.start();
    await first.service.enable("primary", "matrix-demo");
    await until(() => registry.online(first.keys.key.deviceId));
    first.service.dispose();
    await until(() => !registry.online(first.keys.key.deviceId));

    // Same profile and key: it reconnects by itself.
    const again = createDesktopLinkService({
      pairing: first.pairing, credential: async () => ownerJwt(), consent: ALLOW_ALL,
      openCore: async () => createFakeHerdrCore().connect(), preferences: createDesktopLinkPreferenceStore(first.userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
    });
    cleanup.push(() => again.dispose());
    await again.start();
    await until(() => registry.online(first.keys.key.deviceId));
  });

  // Fault detected (review): every `open` the computer sent started a new connection to
  // the core, with no limit.
  it("closes the link when the computer opens streams faster than ten in ten seconds", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing, sockets } = mac(origin);
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    const socket = sockets.at(-1)!;
    const closes: Array<number | undefined> = [];
    const close = socket.close.bind(socket);
    socket.close = (code?: number) => { closes.push(code); close(code); };
    // As if the computer sent them: frames arrive through the socket's own message event.
    const fromComputer = (stream: number) => (socket as unknown as EventTarget)
      .dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ t: "open", stream }) }));
    // The link's own streams so far count too: within eleven more opens, it closes.
    let sent = 0;
    while (closes.length === 0 && sent < 11) fromComputer(100 + sent++);
    // 4008, not 1008: a browser-style WebSocket throws on 1008 and stays open.
    expect(closes).toEqual([4008]);
    expect(sent).toBeGreaterThanOrEqual(1);
  });

  // Fault detected (review): Stop pressed while enable was still reading the pairing was
  // undone when that read finished: the link came back on after the owner stopped it.
  it("keeps the link off when Stop comes while it is being turned on", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing, sockets } = mac(origin);
    await pairing.pair();
    await service.start();
    let release: () => void = () => {};
    const read = pairing.linkIdentity.getMockImplementation()!;
    pairing.linkIdentity.mockImplementationOnce(async (signal) => { await new Promise<void>((resolve) => { release = resolve; }); return read(signal); });
    const enabling = service.enable("primary", "matrix-demo");
    await service.disable("primary");
    release();
    await enabling;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sockets).toHaveLength(0);
    expect(registry.online(keys.key.deviceId)).toBe(false);
  });

  // Fault detected (review): a connection that dropped before `ready` was never given up,
  // so the link stayed "connecting" until switched off and on.
  it("gives up a connection that is not admitted in time and dials again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "Date"] });
    try {
      const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
      cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
      const key = desktopKeys();
      const sockets: Array<{ closed: number | null }> = [];
      const service = createDesktopLinkService({
        pairing: { key, linkIdentity: async () => ({ origin: "https://computer.test", ownerId: OWNER, machineId: MACHINE, deviceId: key.deviceId, revision: 1, privateKey: key.privateKey }) } as never,
        credential: async () => "token", consent: ALLOW_ALL, openCore: async () => createFakeHerdrCore().connect(),
        preferences: createDesktopLinkPreferenceStore(userData, () => {}), home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" },
        createSocket: () => {
          const entry = { closed: null as number | null };
          sockets.push(entry);
          return { binaryType: "", bufferedAmount: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: (code?: number) => { entry.closed = code ?? 1000; } } as never;
        },
        random: () => 0, log: () => {},
      });
      cleanup.push(() => service.dispose());
      await service.start();
      await service.enable("primary", "matrix-demo");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets[0]!.closed).not.toBeNull();
      expect(sockets.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // Fault detected (review): Stop closed with 1001, which the WebSocket refused, so the
  // connection stayed open and a retry could open a second one.
  it("closes the WebSocket for real when the owner turns the link off", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing, sockets } = mac(origin);
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    const socket = sockets.at(-1)!;
    const closes: Array<number | undefined> = [];
    const close = socket.close.bind(socket);
    socket.close = (code?: number) => { closes.push(code); close(code); };
    await service.disable("primary");
    expect(closes).toEqual([1000]);
    await until(() => !registry.online(keys.key.deviceId));
  });

  // Fault detected (review): the account restored at startup was never recorded, so signing
  // in as someone else kept the first account's computer linked to this desktop.
  it("closes the link when another account signs in over the one restored at startup", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing } = mac(origin);
    service.seedAccount({ signedIn: true, userId: "user_a", handle: "alice" });
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    service.authChanged({ signedIn: true, userId: "user_b", handle: "bob" });
    await until(() => !registry.online(keys.key.deviceId));
  });

  it("stops for good when the computer removes the desktop, until it is paired again", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing } = mac(origin);
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    // Remove on the computer is 2698's disconnect.
    expect((await pairing.unpair()).status).toBe(200);
    await until(() => service.statuses()[0]?.state === "removed");
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(registry.online(keys.key.deviceId)).toBe(false);
    await expect(service.enable("primary", "matrix-demo")).rejects.toMatchObject({ reason: "not_paired" });
    // Paired again, at a newer revision, it links again.
    expect(await pairing.pair()).toBe(3);
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
  });

  it("reconnects after the link drops, and at once on wake", async () => {
    const { origin, registry } = await computer();
    const { service, keys, pairing, sockets } = mac(origin);
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(keys.key.deviceId));
    // A network cut: the socket dies without a clean close from the gateway.
    (sockets.at(-1) as unknown as WebSocket).close(4000);
    await until(() => sockets.length === 2 && registry.online(keys.key.deviceId));
    service.wake();
    expect(registry.online(keys.key.deviceId)).toBe(true);
  });

  it("refuses an org member's credential: nothing pairs or links", async () => {
    const { origin, registry } = await computer();
    const pairing = testPairing(origin, desktopKeys(), "org_member");
    const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
    cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
    const service = createDesktopLinkService({
      pairing, credential: async () => ownerJwt("org_member"), consent: ALLOW_ALL,
      openCore: async () => createFakeHerdrCore().connect(), preferences: createDesktopLinkPreferenceStore(userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
    });
    cleanup.push(() => service.dispose());
    await service.start();
    await expect(service.enable("primary", "matrix-demo")).rejects.toMatchObject({ reason: "unavailable" });
    expect(registry.size()).toBe(0);
  });
});

describe("Desktop link service after pairing and account changes", () => {
  // Fault detected (review): a device paired before it had a saved choice (paired under
  // 2698 first, or after signing in again) showed no link at all, only "Pair this device".
  it("shows a paired device with no saved choice as off, ready to turn on", async () => {
    const { origin, registry } = await computer();
    const { service, pairing } = mac(origin);
    await pairing.pair();
    await service.start();
    expect(service.statuses()).toMatchObject([{ slot: "primary", state: "off" }]);
    expect(registry.size()).toBe(0);
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(pairing.key.deviceId));
  });

  // Fault detected (review): switching to another account or computer without signing
  // out left the link to the old computer open.
  it("closes the link when the signed-in account changes without a sign-out", async () => {
    const { origin, registry } = await computer();
    const { service, pairing } = mac(origin);
    await pairing.pair();
    await service.start();
    service.authChanged({ signedIn: true, userId: OWNER, handle: HANDLE });
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(pairing.key.deviceId));
    service.authChanged({ signedIn: true, userId: OWNER, handle: HANDLE });
    expect(registry.online(pairing.key.deviceId)).toBe(true);
    service.authChanged({ signedIn: true, userId: "someone_else", handle: "their-computer" });
    await until(() => !registry.online(pairing.key.deviceId));
  });
});

describe("Desktop link service consent (D2)", () => {
  function owner(origin: string, consent: { ask: (computer: string, request: unknown) => Promise<boolean>; fullAccess: () => Promise<boolean> }, core = createFakeHerdrCore()) {
    const pairing = testPairing(origin);
    const userData = mkdtempSync(join(tmpdir(), "desktop-link-"));
    cleanup.push(() => rmSync(userData, { recursive: true, force: true }));
    const service = createDesktopLinkService({
      pairing, credential: async () => ownerJwt(), consent: { ask: (computer, request) => consent.ask(computer, request), fullAccess: consent.fullAccess },
      openCore: async () => core.connect(), preferences: createDesktopLinkPreferenceStore(userData, () => {}),
      home: tmpdir(), deviceName: "desktop", app: { version: "0.9.0", os: "macOS" },
      createSocket: (url, headers) => new WebSocket(url, { headers } as never) as unknown as DesktopLinkSocket, log: () => {},
    });
    cleanup.push(() => service.dispose());
    return { pairing, service, core };
  }

  it("asks the owner, names the computer, and nothing runs when the owner declines", async () => {
    const { origin, registry } = await computer();
    const ask = vi.fn(async () => false);
    const { pairing, service, core } = owner(origin, { ask, fullAccess: async () => false });
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(pairing.key.deviceId));
    const adapter = registry.adapter(pairing.key.deviceId)!;
    await expect(adapter.create({ cols: 80, rows: 24 }, { argv: ["uname", "-a"] })).rejects.toThrow();
    expect(core.calls.some((call) => call.method === "terminal.run")).toBe(false);
    expect(ask).toHaveBeenCalledWith("matrix-demo", { kind: "run", command: "uname -a", cwd: realpathSync(tmpdir()) });
  });

  it("runs without asking while Full Access is allowed for this pairing", async () => {
    const { origin, registry } = await computer();
    const ask = vi.fn(async () => false);
    const { pairing, service, core } = owner(origin, { ask, fullAccess: async () => true });
    await pairing.pair();
    await service.start();
    await service.enable("primary", "matrix-demo");
    await until(() => registry.online(pairing.key.deviceId));
    await registry.adapter(pairing.key.deviceId)!.create({ cols: 80, rows: 24 }, { argv: ["uname"] });
    expect(core.calls.some((call) => call.method === "terminal.run")).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });
});
