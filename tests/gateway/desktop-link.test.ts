// Desktop link gateway side (spec 2716): enrolment, the owner-only auth matrix,
// link admission with device proofs, revocation and replacement, and a real
// herdr-core conversation carried over the link to a desktop stand-in.
import { once } from "node:events";
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_LINK_CLOSE, DesktopLinkChallengeFrameSchema, DesktopLinkEnrolChallengeSchema, DesktopLinkMachineListSchema,
  desktopLinkEnrolProofMessage, desktopLinkProofMessage, desktopLinkRevisionTag,
} from "@matrix-os/contracts/desktop-link";
import { authMiddleware } from "../../packages/gateway/src/auth.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../../packages/gateway/src/desktop-link/routes.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "../../packages/gateway/src/desktop-link/registry.js";
import type { DesktopLinkDatabase } from "../../packages/gateway/src/desktop-link/store.js";
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
    signEnrol: (nonce: string, ownerId = OWNER) =>
      signWith(keys.privateKey, desktopLinkEnrolProofMessage({ ownerId, machineId: MACHINE, deviceId, nonce })),
    signLink: (nonce: string, revision: number, machineId = MACHINE) =>
      signWith(keys.privateKey, desktopLinkProofMessage({ ownerId: OWNER, machineId, deviceId, revision, nonce })),
  };
}

const cleanup: Array<() => Promise<void> | void> = [];
let db: Kysely<DesktopLinkDatabase>;

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
  await db.schema.dropTable("desktop_link_devices").ifExists().execute();
});
afterAll(async () => db.destroy());

async function gateway(options: {
  registry?: DesktopLinkRegistry; enabled?: boolean; ownerDatabase?: Kysely<DesktopLinkDatabase> | null; now?: () => number;
} = {}) {
  const app = new Hono();
  app.use("*", authMiddleware(SECRET));
  const ws = createNodeWebSocket({ app });
  const config = readDesktopLinkConfig({
    MATRIX_DESKTOP_LINK_ENABLED: options.enabled === false ? undefined : "1",
    MATRIX_USER_ID: OWNER,
    MATRIX_MACHINE_ID: MACHINE,
  });
  const registry = registerDesktopLinkRoutes({
    app, upgradeWebSocket: ws.upgradeWebSocket, config,
    ownerDatabase: options.ownerDatabase === undefined ? db : options.ownerDatabase,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.now ? { now: options.now } : {}),
    log: () => {},
  });
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

async function enrol(http: Awaited<ReturnType<typeof gateway>>["http"], mac: ReturnType<typeof testMac>, name = "Hamed's MacBook") {
  const challengeResponse = await http("/api/desktop-link/enrol/challenge", { method: "POST", body: JSON.stringify({ deviceId: mac.deviceId }) });
  expect(challengeResponse.status).toBe(200);
  const challenge = DesktopLinkEnrolChallengeSchema.parse(await challengeResponse.json());
  expect(challenge.machineId).toBe(MACHINE);
  return http("/api/desktop-link/enrol", {
    method: "POST",
    body: JSON.stringify({ nonce: challenge.nonce, publicKey: mac.publicKey, signature: mac.signEnrol(challenge.nonce), name }),
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
        t: "proof", deviceId: mac.deviceId, revision: options.revision, signature: mac.signLink(nonce, options.revision),
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

describe("Desktop link enrolment", () => {
  it("enrols a desktop for the owner and lists it offline until it links", async () => {
    const { http } = await gateway();
    const mac = testMac();
    const response = await enrol(http, mac);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deviceId: mac.deviceId, revision: 1, machineId: MACHINE });
    const list = DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json());
    expect(list.machines).toMatchObject([{ deviceId: mac.deviceId, name: "Hamed's MacBook", revision: 1, state: "offline", lastSeenAt: null }]);
  });

  it("refuses a proof signed for another owner, a reused challenge and a second live enrolment", async () => {
    const { http } = await gateway();
    const mac = testMac();
    const first = DesktopLinkEnrolChallengeSchema.parse(await (await http("/api/desktop-link/enrol/challenge", {
      method: "POST", body: JSON.stringify({ deviceId: mac.deviceId }),
    })).json());
    const forged = await http("/api/desktop-link/enrol", { method: "POST", body: JSON.stringify({
      nonce: first.nonce, publicKey: mac.publicKey, signature: mac.signEnrol(first.nonce, "someone_else"), name: "desktop",
    }) });
    expect(forged.status).toBe(403);
    // The challenge was consumed by the failed attempt.
    const replay = await http("/api/desktop-link/enrol", { method: "POST", body: JSON.stringify({
      nonce: first.nonce, publicKey: mac.publicKey, signature: mac.signEnrol(first.nonce), name: "desktop",
    }) });
    expect(replay.status).toBe(403);
    expect((await enrol(http, mac)).status).toBe(200);
    expect((await enrol(http, mac)).status).toBe(409);
  });

  it("caps enrolled desktops at five", async () => {
    const { http } = await gateway();
    for (let index = 0; index < 5; index += 1) expect((await enrol(http, testMac(), `desktop ${index}`)).status).toBe(200);
    const sixth = await enrol(http, testMac());
    expect(sixth.status).toBe(409);
    expect(await sixth.json()).toEqual({ error: "too_many" });
  });

  it("removes a desktop only with the current revision tag, then allows a fresh enrolment at a higher revision", async () => {
    const { http } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const path = `/api/desktop-link/machines/${mac.deviceId}`;
    expect((await http(path, { method: "DELETE" })).status).toBe(412);
    expect((await http(path, { method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 2 }) } })).status).toBe(409);
    const removed = await http(path, { method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 1 }) } });
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ deviceId: mac.deviceId, revision: 2 });
    expect(DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json()).machines).toEqual([]);
    const again = await enrol(http, mac);
    expect(await again.json()).toMatchObject({ revision: 3 });
  });
});

describe("Desktop link auth matrix", () => {
  it("refuses everyone but the owner on every route and on the link upgrade", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const routes: Array<[string, RequestInit]> = [
      ["/api/desktop-link/machines", {}],
      ["/api/desktop-link/enrol/challenge", { method: "POST", body: JSON.stringify({ deviceId: mac.deviceId }) }],
      ["/api/desktop-link/enrol", { method: "POST", body: "{}" }],
      [`/api/desktop-link/machines/${mac.deviceId}`, { method: "DELETE" }],
    ];
    for (const [path, init] of routes) {
      expect((await http(path, init, {})).status, `${path} anonymous`).toBe(401);
      expect((await http(path, init, ownerHeaders("org_member"))).status, `${path} org member`).toBe(403);
      // The gateway's own runtime token with no user named is the configured owner:
      // the computer's own shell proxy sends exactly that, as for Herdr's routes.
      expect((await http(path, init, { authorization: `Bearer ${SECRET}` })).status, `${path} gateway token`).not.toBe(403);
    }
    for (const headers of [{}, ownerHeaders("org_member")]) {
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
  it("admits an enrolled desktop with a fresh proof and shows it online", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    expect(registry?.online(mac.deviceId)).toBe(true);
    const list = DesktopLinkMachineListSchema.parse(await (await http("/api/desktop-link/machines")).json());
    expect(list.machines[0]?.state).toBe("online");
  });

  it("closes a link whose proof is wrong, stale, for another computer or not a proof", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    const stranger = testMac();
    await enrol(http, mac);
    const attempts = [
      dialMac(base, mac, { revision: 2 }),
      dialMac(base, stranger, { revision: 1 }),
      dialMac(base, mac, { revision: 1, proof: (nonce) => ({
        t: "proof", deviceId: mac.deviceId, revision: 1, signature: mac.signLink(nonce, 1, "00000000-0000-4000-8000-000000000000"),
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

  it("refuses binary bytes before admission", async () => {
    const { http, base } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: ownerHeaders() });
    cleanup.push(() => socket.terminate());
    await once(socket, "open");
    socket.send(Buffer.from([1, 2, 3]));
    const [code] = await once(socket, "close") as [number];
    expect(code).toBe(DESKTOP_LINK_CLOSE.policy);
  });

  it("replaces an older link for the same desktop, and removal closes the live link at once", async () => {
    const { http, base, registry } = await gateway();
    const mac = testMac();
    await enrol(http, mac);
    const first = dialMac(base, mac, { revision: 1 });
    await first.ready();
    const second = dialMac(base, mac, { revision: 1 });
    await second.ready();
    await first.closed();
    expect(first.closeCode()).toBe(DESKTOP_LINK_CLOSE.replaced);
    expect(registry?.online(mac.deviceId)).toBe(true);

    const removed = await http(`/api/desktop-link/machines/${mac.deviceId}`, {
      method: "DELETE", headers: { "If-Match": desktopLinkRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision: 1 }) },
    });
    expect(removed.status).toBe(200);
    await second.closed();
    expect(second.closeCode()).toBe(DESKTOP_LINK_CLOSE.removed);
    expect(second.control.some((frame) => frame.t === "bye" && frame.reason === "removed")).toBe(true);
    expect(registry?.online(mac.deviceId)).toBe(false);
    // The removed revision never links again.
    const retry = dialMac(base, mac, { revision: 1 });
    await retry.closed();
    expect(retry.closeCode()).toBe(DESKTOP_LINK_CLOSE.auth);
  });

  it("closes a link that stops answering", async () => {
    let now = 1_000_000;
    const registry = createDesktopLinkRegistry({ now: () => now, pingMs: 60_000, staleMs: 45_000 });
    const { http, base } = await gateway({ registry, now: () => now });
    const mac = testMac();
    await enrol(http, mac);
    const link = dialMac(base, mac, { revision: 1 });
    await link.ready();
    now += 46_000;
    registry.sweep();
    await link.closed();
    expect(link.closeCode()).toBe(DESKTOP_LINK_CLOSE.going);
    expect(registry.online(mac.deviceId)).toBe(false);
  });
});

describe("Herdr over the Desktop link", () => {
  it("drops desktop bytes that arrive before the desktop acknowledges the new stream", async () => {
    const registry = createDesktopLinkRegistry({ createAdapter: (open) => createHerdrAdapter({ open }) });
    const { http, base } = await gateway({ registry });
    const core = createFakeHerdrCore();
    core.add("t1", { title: "shell" });
    const mac = testMac();
    await enrol(http, mac);
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
    await enrol(http, mac);
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
