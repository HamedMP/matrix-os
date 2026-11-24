// Desktop link gateway side (spec 2716): admission over 2698 pairing, the owner-only
// auth matrix, link proofs, revocation by pairing revision, last seen (D3), and a
// real herdr-core conversation carried over the link to a desktop stand-in.
import { once } from "node:events";
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { Kysely, sql } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopPairingChallengeSchema, desktopPairingProofMessage, desktopPairingRevisionTag } from "@matrix-os/contracts";
import {
  DESKTOP_LINK_CLOSE, DesktopLinkChallengeFrameSchema, DesktopLinkMachineListSchema, desktopLinkProofMessage,
} from "@matrix-os/contracts/desktop-link";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../../packages/gateway/src/desktop-link/routes.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import { DesktopPairingRepository, type DesktopPairingDatabase } from "../../packages/gateway/src/desktop-pairing/database.js";
import { createRuntimeDesktopPairingRoutes } from "../../packages/gateway/src/desktop-pairing/routes.js";
import { createHerdrAdapter } from "../../packages/gateway/src/herdr/adapter.js";
import { createFakeHerdrCore } from "./fixtures/fake-herdr-core-server.js";

const OWNER = "owner_mac";
const MACHINE = "6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
const SECRET = "isolated-runtime-auth-for-desktop-link-tests";

function ownerHeaders(userId = OWNER): Record<string, string> {
  return {
    authorization: `Bearer ${SECRET}`,
    "x-platform-user-id": userId,
    "x-platform-verified": createHmac("sha256", SECRET).update(userId).digest("hex"),
  };
}

function testMac() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const deviceId = createHash("sha256").update(spki).digest("hex");
  const signWith = (key: KeyObject, message: string) => sign(null, Buffer.from(message), key).toString("base64url");
  return {
    deviceId,
    publicKey: spki.toString("base64url"),
    signPair: (nonce: string, revision: number) =>
      signWith(keys.privateKey, desktopPairingProofMessage({ ownerId: OWNER, machineId: MACHINE, deviceId, revision, nonce })),
    signLink: (nonce: string, revision: number, machineId = MACHINE) =>
      signWith(keys.privateKey, desktopLinkProofMessage({ ownerId: OWNER, machineId, deviceId, revision, nonce })),
  };
}

const cleanup: Array<() => Promise<void> | void> = [];
let db: Kysely<DesktopPairingDatabase>;

beforeAll(async () => {
  const pglite = await KyselyPGlite.create();
  db = new Kysely({ dialect: pglite.dialect });
});
beforeEach(() => {
  vi.stubEnv("MATRIX_USER_ID", OWNER);
  vi.stubEnv("PLATFORM_JWT_SECRET", "");
  vi.stubEnv("PLATFORM_JWT_PUBLIC_KEY", "");
});
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  await db.schema.dropTable("desktop_pairings").ifExists().execute();
});
afterAll(async () => db.destroy());

async function gateway(options: {
  registry?: DesktopLinkRegistry; enabled?: boolean; ownerDatabase?: Kysely<DesktopPairingDatabase> | null; now?: () => number;
} = {}) {
  const app = new Hono();
  app.use("*", authMiddleware(SECRET));
  const ws = createNodeWebSocket({ app });
  const env = {
    MATRIX_DESKTOP_PAIRING_ENABLED: "1", MATRIX_USER_ID: OWNER, MATRIX_MACHINE_ID: MACHINE,
    MATRIX_HANDLE: "owner-mac", MATRIX_RUNTIME_SLOT: "primary",
  };
  const config = readDesktopLinkConfig({ ...env, MATRIX_DESKTOP_LINK_ENABLED: options.enabled === false ? undefined : "1" });
  const ownerDatabase = options.ownerDatabase === undefined ? db : options.ownerDatabase;
  // 2698's own pairing routes, told about changes as the gateway wires them.
  let linked: DesktopLinkRegistry | null = null;
  app.route("/api/desktop-pairing", await createRuntimeDesktopPairingRoutes({
    ownerDatabase, env, ...(options.now ? { now: options.now } : {}), onPairingChanged: (state) => linked?.pairingChanged(state),
  }));
  const registry = registerDesktopLinkRoutes({
    app, upgradeWebSocket: ws.upgradeWebSocket, config, ownerDatabase,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.now ? { now: options.now } : {}),
    log: () => {},
  });
  linked = registry;
  if (registry) cleanup.push(() => registry.drain());
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  ws.injectWebSocket(server);
  if (!server.listening) await once(server, "listening");
  cleanup.push(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no listener");
  const base = `127.0.0.1:${address.port}`;
  const http = (path: string, init: RequestInit = {}, headers: Record<string, string> = ownerHeaders()) =>
    fetch(`http://${base}${path}`, {
      ...init,
      headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string> ?? {}) },
      signal: AbortSignal.timeout(5_000),
    });
  return { base, registry, http };
}

/** Pairs the desktop through 2698's routes. */
async function pair(http: Awaited<ReturnType<typeof gateway>>["http"], mac: ReturnType<typeof testMac>, revision = 0) {
  const challengeResponse = await http("/api/desktop-pairing/challenge", { method: "POST", body: JSON.stringify({ deviceId: mac.deviceId, revision }) });
  expect(challengeResponse.status).toBe(200);
  const challenge = DesktopPairingChallengeSchema.parse(await challengeResponse.json());
  return http("/api/desktop-pairing/pair", {
    method: "POST",
    body: JSON.stringify({ nonce: challenge.nonce, publicKey: mac.publicKey, signature: mac.signPair(challenge.nonce, revision) }),
  });
}

/** Disconnects the paired desktop through 2698's route, as Remove on the computer does. */
function unpair(http: Awaited<ReturnType<typeof gateway>>["http"], mac: ReturnType<typeof testMac>, revision: number) {
  return http(`/api/desktop-pairing/${mac.deviceId}`, {
    method: "DELETE", body: JSON.stringify({ revision }),
    headers: { "If-Match": desktopPairingRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision }) },
  });
}

/** A desktop stand-in: dials out, proves itself, and pipes core streams to `core` when given one. */
function dialMac(base: string, mac: ReturnType<typeof testMac>, options: {
  revision: number; headers?: Record<string, string>; core?: ReturnType<typeof createFakeHerdrCore>; proof?: (nonce: string) => unknown;
  staleBytes?: boolean;
}) {
  const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: options.headers ?? ownerHeaders() });
  const control: Array<Record<string, unknown>> = [];
  let closeCode: number | null = null;
  let upgradeStatus: number | null = null;
  let stream: { id: number; pipe: ReturnType<ReturnType<typeof createFakeHerdrCore>["connect"]> } | null = null;
  socket.on("unexpected-response", (_request, response) => { upgradeStatus = response.statusCode ?? null; socket.terminate(); });
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    if (isBinary) { stream?.pipe.write(Buffer.from(data as Buffer)); return; }
    const frame = JSON.parse(String(data)) as Record<string, unknown>;
    control.push(frame);
    if (frame.t === "challenge") {
      const { nonce } = DesktopLinkChallengeFrameSchema.parse(frame);
      socket.send(JSON.stringify(options.proof?.(nonce) ?? {
        t: "proof", name: "Hamed's MacBook", deviceId: mac.deviceId, revision: options.revision, signature: mac.signLink(nonce, options.revision),
        app: { version: "0.9.0", os: "macOS 26.1" },
      }));
    } else if (frame.t === "open" && options.core) {
      stream?.pipe.destroy();
      const id = frame.stream as number;
      const pipe = options.core.connect();
      pipe.on("data", (chunk: Buffer) => { if (stream?.id === id) socket.send(chunk); });
      pipe.on("close", () => { if (stream?.id === id) { stream = null; socket.send(JSON.stringify({ t: "end", stream: id })); } });
      // Late bytes from an older stream, as a slow reply would arrive: the gateway must drop them.
      if (options.staleBytes) socket.send(Buffer.from("stale reply from an older stream\n"));
      socket.send(JSON.stringify({ t: "opened", stream: id }));
      stream = { id, pipe };
    } else if (frame.t === "close" && stream?.id === frame.stream) {
      const ending = stream;
      stream = null;
      ending.pipe.destroy();
    }
  });
  socket.on("close", (code) => { closeCode = code; });
  cleanup.push(() => { if (closeCode === null) socket.terminate(); });
  const until = async (check: () => boolean, ms = 3_000) => {
    const start = Date.now();
    while (!check()) {
      if (Date.now() - start > ms) throw new Error(`timed out; control=${JSON.stringify(control)} close=${closeCode} upgrade=${upgradeStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return {
    socket, control,
    closeCode: () => closeCode,
    upgradeStatus: () => upgradeStatus,
    ready: () => until(() => control.some((frame) => frame.t === "ready")),
    closed: () => until(() => closeCode !== null || upgradeStatus !== null),
    until,
  };
}

const listed = async (http: Awaited<ReturnType<typeof gateway>>["http"]) =>
  DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json()).machines;

describe("Pairing is the desktop link's admission (2698)", () => {
  it("lists the paired desktop offline until it links, and nothing before pairing", async () => {
    const { http } = await gateway();
    const mac = testMac();
    expect(await listed(http)).toEqual([]);
    expect((await pair(http, mac)).status).toBe(200);
    expect(await listed(http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 1, state: "offline", lastSeenAt: null }]);
  });

  it("admits only the paired device, at exactly the current pairing revision", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const unpaired = dialMac(base, mac, { revision: 1 });
    await unpaired.closed();
    expect(unpaired.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    await pair(http, mac);
    const other = dialMac(base, testMac(), { revision: 1 });
    await other.closed();
    expect(other.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
  });

  // Fault detected: a disconnect (or Remove on the computer) left a live link
  // working until it dropped by itself, so a revoked desktop kept running terminals.
  it("ends the live link the moment the pairing is disconnected, and refuses it after", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect((await unpair(http, mac, 1)).status).toBe(200);
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(link.control.some((frame) => frame.t === "bye" && frame.reason === "removed")).toBe(true);
    expect(registry?.online(mac.deviceId)).toBe(false);
    for (const revision of [1, 2]) {
      const retry = dialMac(base, mac, { revision });
      await retry.closed();
      expect(retry.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    }
    expect(await (await pair(http, mac, 2)).json()).toMatchObject({ deviceId: mac.deviceId, revision: 3 });
    const again = dialMac(base, mac, { revision: 3 });
    await again.ready();
  });

  // Fault detected (review): a disconnect that committed while the link's proof key was
  // being read still admitted the link, since the change notice only ends admitted links.
  it("refuses a link whose pairing changed while its proof was being checked", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reading = false;
    const original = DesktopPairingRepository.prototype.readRegisteredKey;
    const spy = vi.spyOn(DesktopPairingRepository.prototype, "readRegisteredKey").mockImplementation(async function (this: DesktopPairingRepository, ...args) {
      const key = await original.apply(this, args);
      reading = true;
      await gate;
      return key;
    });
    const link = dialMac(base, mac, { revision: 1 });
    await link.until(() => reading);
    expect((await unpair(http, mac, 1)).status).toBe(200);
    release();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(registry?.online(mac.deviceId)).toBe(false);
    spy.mockRestore();
  });

  it("ends a live link whose pairing changed without a notice, within a few heartbeats", async () => {
    const now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 3_600_000, staleMs: 3_600_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    await db.updateTable("desktop_pairings").set({ device_id: null, public_key: null, revision: 2 }).execute();
    for (let beat = 0; beat < 4; beat += 1) registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
  });

  it("refuses a link whose pairing changed without a notice, before its next core stream", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core: createFakeHerdrCore() });
    await link.ready();
    // As if another gateway process disconnected it: the row changed, no notice came.
    await db.updateTable("desktop_pairings").set({ device_id: null, public_key: null, revision: 2 }).execute();
    const listing = await registry!.adapter(mac.deviceId)!.list();
    expect(listing.status).not.toBe("ready");
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
  });
});

describe("Desktop link auth matrix", () => {
  // Fault detected (review): the machine list took the bare gateway token, which
  // 2698's pairing routes refuse, so a client that could list a desktop got 403 on Remove.
  it("answers the same principals as 2698's pairing routes", async () => {
    const { http } = await gateway();
    const shell = { authorization: `Bearer ${SECRET}` };
    expect((await http("/api/desktop-link/machines", {}, shell)).status).toBe(403);
    expect((await http("/api/desktop-pairing", {}, shell)).status).toBe(403);
    expect((await http("/api/desktop-link/machines")).status).toBe(200);
    expect((await http("/api/desktop-pairing")).status).toBe(200);
  });

  it("refuses everyone but the owner on the machine list, and only a signed-in desktop opens the link", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    expect((await http("/api/desktop-link/machines", {}, {})).status).toBe(401);
    expect((await http("/api/desktop-link/machines", {}, ownerHeaders("org_member"))).status).toBe(403);
    await pair(http, mac);
    for (const headers of [{}, ownerHeaders("org_member"), { authorization: `Bearer ${SECRET}` }]) {
      const link = dialMac(base, mac, { revision: 1, headers });
      await link.closed();
      expect(link.upgradeStatus()).not.toBeNull();
    }
  });

  it("is absent when switched off and unavailable without the owner database", async () => {
    expect((await (await gateway({ enabled: false })).http("/api/desktop-link/machines")).status).toBe(404);
    expect((await (await gateway({ ownerDatabase: null })).http("/api/desktop-link/machines")).status).toBe(503);
  });
});

describe("Desktop link admission", () => {
  it("admits the paired desktop with a fresh proof and shows it online", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect(registry?.online(mac.deviceId)).toBe(true);
    expect((await listed(http))[0]?.state).toBe("online");
  });

  it("closes a link whose proof is wrong, stale, for another computer or not a proof", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const stranger = testMac();
    await pair(http, mac);
    const attempts = [
      dialMac(base, mac, { revision: 2 }),
      dialMac(base, stranger, { revision: 1 }),
      dialMac(base, mac, { revision: 1, proof: (nonce) => ({
        t: "proof", name: "x", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1, "00000000-0000-4000-8000-000000000000"),
        app: { version: "0.9.0", os: "macOS" },
      }) }),
    ];
    for (const attempt of attempts) {
      await attempt.closed();
      expect(attempt.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
    }
    const garbage = dialMac(base, mac, { revision: 1, proof: () => ({ t: "hello" }) });
    await garbage.closed();
    expect(garbage.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("refuses a self-reported name with control characters", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, proof: (nonce) => ({
      t: "proof", name: "Mac\u0007", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1), app: { version: "0.9.0", os: "macOS" },
    }) });
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("refuses binary bytes before admission", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: ownerHeaders() });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(Buffer.from([1, 2, 3]));
    const [code] = await once(socket, "close") as [number];
    expect(code).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("replaces an older link for the same desktop", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await pair(http, mac);
    const first = dialMac(base, mac, { revision: 1 });
    await first.ready();
    const second = dialMac(base, mac, { revision: 1 });
    await second.ready();
    await first.closed();
    expect(first.closeCode()).toBe(DESKTOP_LINK_CLOSE.replaced);
    expect(registry?.online(mac.deviceId)).toBe(true);
  });

  it("closes a link that stops answering", async () => {
    let now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 60_000, staleMs: 45_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    now += 46_000;
    registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.going);
    expect(registry.online(mac.deviceId)).toBe(false);
  });
});

// D3 (Hamed, 2026-11-25): the paired desktop's name and last seen live on 2698's row.
describe("The paired desktop's name and last seen", () => {
  it("stores the name for the paired device at its revision, keeps it across a restart, and clears it on disconnect and re-pair", async () => {
    const first = await gateway();
    const mac = testMac();
    await pair(first.http, mac);
    const link = dialMac(first.base, mac, { revision: 1 });
    await link.ready();
    await expect.poll(async () => (await listed(first.http))[0]?.name).toBe("Hamed's MacBook");
    link.socket.terminate();
    await link.closed();
    // A new gateway process on the same database still knows it, offline.
    const restarted = await gateway();
    expect(await listed(restarted.http)).toMatchObject([{ name: "Hamed's MacBook", state: "offline", lastSeenAt: expect.any(String) }]);
    expect((await unpair(restarted.http, mac, 1)).status).toBe(200);
    await pair(restarted.http, mac, 2);
    expect(await listed(restarted.http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 3, state: "offline", lastSeenAt: null }]);
  });

  it("writes last seen on admission, then at most once a minute while the desktop stays linked", async () => {
    let now = Date.parse("2026-11-25T10:00:00.000Z");
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 3_600_000, staleMs: 3_600_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    const lastSeen = async () => (await db.selectFrom("desktop_pairings").select("last_seen_at").executeTakeFirstOrThrow()).last_seen_at;
    await expect.poll(async () => (await lastSeen())?.toISOString()).toBe("2026-11-25T10:00:00.000Z");
    const touches = vi.spyOn(DesktopPairingRepository.prototype, "touch");
    for (let beat = 0; beat < 3; beat += 1) { now += 15_000; registry.sweep(); }
    expect(touches).not.toHaveBeenCalled();
    now += 20_000;
    registry.sweep();
    await expect.poll(async () => (await lastSeen())?.toISOString()).toBe("2026-11-25T10:01:05.000Z");
    expect(touches).toHaveBeenCalledTimes(1);
    touches.mockRestore();
  });

  it("adds the D3 columns to a table 2698 created before them, keeping its pairing", async () => {
    await sql`CREATE TABLE desktop_pairings (
      owner_id TEXT NOT NULL, machine_id UUID NOT NULL, device_id TEXT, public_key TEXT,
      revision BIGINT NOT NULL, PRIMARY KEY (owner_id, machine_id))`.execute(db);
    const mac = testMac();
    await db.insertInto("desktop_pairings").values({
      owner_id: OWNER, machine_id: MACHINE, device_id: mac.deviceId, public_key: mac.publicKey, revision: 4,
    } as never).execute();
    const { http, base } = await gateway();
    expect(await listed(http)).toEqual([{ deviceId: mac.deviceId, name: "Paired desktop", revision: 4, state: "offline", lastSeenAt: null }]);
    const link = dialMac(base, mac, { revision: 4 });
    await link.ready();
    await expect.poll(async () => (await listed(http))[0]?.name).toBe("Hamed's MacBook");
  });
});

describe("Herdr over the Desktop link", () => {
  it("drops desktop bytes that arrive before the desktop acknowledges the new stream", async () => {
    const registry = createDesktopLinkRegistry({ createAdapter: (open) => createHerdrAdapter({ open }) });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "shell" });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core, staleBytes: true });
    await link.ready();
    const listed = await registry.adapter(mac.deviceId)!.list();
    expect(listed.status).toBe("ready");
    expect(listed.sessions.map((session) => session.id)).toEqual(["t1"]);
  });

  it("lists and attaches the desktop's terminals through the link, and reports the desktop gone when it drops", async () => {
    const registry = createDesktopLinkRegistry({
      createAdapter: (open) => createHerdrAdapter({ open, captureQuietMs: 5, captureMaxMs: 100 }),
    });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "claude on the desktop", status: { state: "working" }, screen: "hello from darwin" });
    const mac = testMac();
    await pair(http, mac);
    const link = dialMac(base, mac, { revision: 1, core });
    await link.ready();

    const adapter = registry.adapter(mac.deviceId);
    expect(adapter).not.toBeNull();
    const listed = await adapter!.list();
    expect(listed.status).toBe("ready");
    expect(listed.sessions).toMatchObject([{ id: "t1", title: "claude on the desktop", status: "working" }]);

    const output: string[] = [];
    let ended: string | null = null;
    const attachment = await adapter!.attach("t1", { cols: 80, rows: 24 }, {
      output: (data, consumed) => { output.push(data); consumed(); },
      closed: (reason) => { ended = reason; },
    }, { observe: true });
    await link.until(() => output.join("").includes("hello from darwin"));
    core.output("t1", "more output");
    await link.until(() => output.join("").includes("more output"));

    link.socket.terminate();
    await link.until(() => ended !== null);
    expect(ended).toBe("disconnected");
    expect(registry.adapter(mac.deviceId)).toBeNull();
    attachment.detach();
  });
});

// Fault detected (review): an adapter outlived its desktop going offline, and replacing
// that desktop with another left it open, so adapters piled up past the link cap.
describe("Desktop link registry adapters", () => {
  function fakeLink(deviceId: string, revision: number) {
    let closed = false;
    return {
      info: { deviceId, revision } as never,
      get closed() { return closed; },
      lastSeen: () => Date.now(),
      openStream: async () => { throw new Error("unused"); },
      receiveControl: () => {}, receiveBinary: () => {}, send: () => {},
      closedBy: () => { closed = true; },
      close: () => { closed = true; },
    };
  }

  it("closes the adapter of a desktop that went offline once another desktop links or the pairing moves on", () => {
    const closedAdapters: string[] = [];
    let made = 0;
    const registry = createDesktopLinkRegistry({
      maxLinks: 1,
      createAdapter: () => { const id = `a${made++}`; return { close: () => closedAdapters.push(id) } as never; },
    });
    const first = fakeLink("desktop-a", 1);
    expect(registry.admit(first as never)).toBe(true);
    registry.closed(first as never);
    expect(closedAdapters).toEqual([]);
    expect(registry.admit(fakeLink("desktop-b", 2) as never)).toBe(true);
    expect(closedAdapters).toEqual(["a0"]);
    registry.closed(fakeLink("desktop-b", 2) as never);
    registry.pairingChanged({ deviceId: null, revision: 3 });
    expect(closedAdapters).toEqual(["a0", "a1"]);
    void registry.drain();
  });
});
