// Shared harness for the desktop link gateway tests (spec 2716): a gateway with
// the auth middleware, 2698's real pairing routes and the desktop link routes on
// pglite, a desktop stand-in that pairs and dials out, and pipes core streams to
// a fake core, optionally through the real desktop-side guard.
import { once } from "node:events";
import { createHash, createHmac, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { Hono } from "hono";
import { Kysely } from "kysely";
import { KyselyPGlite } from "kysely-pglite";
import { WebSocket } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { DesktopPairingChallengeSchema, desktopPairingProofMessage, desktopPairingRevisionTag } from "@matrix-os/contracts";
import { DesktopLinkChallengeFrameSchema, desktopLinkProofMessage } from "@matrix-os/contracts/desktop-link";
import { authMiddleware } from "../../../packages/gateway/src/auth.js";
import { readDesktopLinkConfig, registerDesktopLinkRoutes } from "../../../packages/gateway/src/desktop-link/routes.js";
import type { DesktopLinkRegistry } from "../../../packages/gateway/src/desktop-link/registry.js";
import type { DesktopPairingDatabase } from "../../../packages/gateway/src/desktop-pairing/database.js";
import { createRuntimeDesktopPairingRoutes } from "../../../packages/gateway/src/desktop-pairing/routes.js";
import { createDesktopLinkGuard } from "../../../desktop/src/main/desktop-link/guard";
import type { createFakeHerdrCore } from "./fake-herdr-core-server.js";

export const OWNER = "owner_mac";
export const MACHINE = "6f1c2b8e-3a4d-4e5f-8a9b-0c1d2e3f4a5b";
/** The token a process in one of the computer's own terminals holds (spec 2692). */
export const LOCAL_TOKEN = "a".repeat(64);
export const SECRET = "isolated-runtime-auth-for-desktop-link-tests";

export function ownerHeaders(userId = OWNER): Record<string, string> {
  return {
    authorization: `Bearer ${SECRET}`,
    "x-platform-user-id": userId,
    "x-platform-verified": createHmac("sha256", SECRET).update(userId).digest("hex"),
  };
}

export function testMac() {
  const keys = generateKeyPairSync("ed25519");
  const spki = keys.publicKey.export({ format: "der", type: "spki" });
  const deviceId = createHash("sha256").update(spki).digest("hex");
  const signWith = (key: KeyObject, message: string) => sign(null, Buffer.from(message), key).toString("base64url");
  return {
    deviceId,
    publicKey: spki.toString("base64url"),
    signPair: (nonce: string, revision: number, ownerId = OWNER) =>
      signWith(keys.privateKey, desktopPairingProofMessage({ ownerId, machineId: MACHINE, deviceId, revision, nonce })),
    signLink: (nonce: string, revision: number, machineId = MACHINE) =>
      signWith(keys.privateKey, desktopLinkProofMessage({ ownerId: OWNER, machineId, deviceId, revision, nonce })),
  };
}

export const cleanup: Array<() => Promise<void> | void> = [];
export let db: Kysely<DesktopPairingDatabase>;

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

export async function gateway(options: {
  /** Registers more routes on the same app before it serves (the desktop terminal socket). */
  extend?: (app: Hono, upgradeWebSocket: ReturnType<typeof createNodeWebSocket>["upgradeWebSocket"], registry: DesktopLinkRegistry) => void;
  registry?: DesktopLinkRegistry; enabled?: boolean;
  verbs?: Parameters<typeof registerDesktopLinkRoutes>[0]["verbs"]; waiter?: Parameters<typeof registerDesktopLinkRoutes>[0]["waiter"]; ownerDatabase?: Kysely<DesktopPairingDatabase> | null; now?: () => number;
} = {}) {
  const app = new Hono();
  app.use("*", authMiddleware(SECRET, { localTerminalAgentToken: () => LOCAL_TOKEN }));
  const ws = createNodeWebSocket({ app });
  const env = {
    MATRIX_DESKTOP_PAIRING_ENABLED: "1", MATRIX_USER_ID: OWNER, MATRIX_MACHINE_ID: MACHINE,
    MATRIX_HANDLE: "owner-mac", MATRIX_RUNTIME_SLOT: "primary",
  };
  const config = readDesktopLinkConfig({ ...env, MATRIX_DESKTOP_LINK_ENABLED: options.enabled === false ? undefined : "1" });
  // 2698's own pairing routes, told about changes as the gateway wires them.
  let linked: DesktopLinkRegistry | null = null;
  const ownerDatabase = options.ownerDatabase === undefined ? db : options.ownerDatabase;
  app.route("/api/desktop-pairing", await createRuntimeDesktopPairingRoutes({
    ownerDatabase, env, ...(options.now ? { now: options.now } : {}), onPairingChanged: (state) => linked?.pairingChanged(state),
  }));
  const registry = registerDesktopLinkRoutes({
    app, upgradeWebSocket: ws.upgradeWebSocket, config,
    ownerDatabase,
    ...(options.registry ? { registry: options.registry } : {}),
    ...(options.verbs ? { verbs: options.verbs } : {}),
    ...(options.waiter ? { waiter: options.waiter } : {}),
    ...(options.now ? { now: options.now } : {}),
    log: () => {},
  });
  linked = registry;
  if (registry) cleanup.push(() => registry.drain());
  if (registry && options.extend) options.extend(app, ws.upgradeWebSocket, registry);
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
      signal: init.signal ?? AbortSignal.timeout(5_000),
    });
  return { base, registry, http };
}

/** Pairs the desktop through 2698's routes; returns the response of the final step. */
export async function pair(http: Awaited<ReturnType<typeof gateway>>["http"], mac: ReturnType<typeof testMac>, revision = 0) {
  const challengeResponse = await http("/api/desktop-pairing/challenge", { method: "POST", body: JSON.stringify({ deviceId: mac.deviceId, revision }) });
  expect(challengeResponse.status).toBe(200);
  const challenge = DesktopPairingChallengeSchema.parse(await challengeResponse.json());
  expect(challenge.machineId).toBe(MACHINE);
  return http("/api/desktop-pairing/pair", {
    method: "POST",
    body: JSON.stringify({ nonce: challenge.nonce, publicKey: mac.publicKey, signature: mac.signPair(challenge.nonce, revision) }),
  });
}

/** Disconnects the paired desktop through 2698's route, as Remove on the computer does. */
export function unpair(http: Awaited<ReturnType<typeof gateway>>["http"], mac: ReturnType<typeof testMac>, revision: number) {
  return http(`/api/desktop-pairing/${mac.deviceId}`, {
    method: "DELETE", body: JSON.stringify({ revision }),
    headers: { "If-Match": desktopPairingRevisionTag({ machineId: MACHINE, deviceId: mac.deviceId, revision }) },
  });
}

/** A desktop stand-in: dials out, proves itself, and pipes core streams to `core` when given one. */
export function dialMac(base: string, mac: ReturnType<typeof testMac>, options: {
  revision: number; headers?: Record<string, string>; core?: ReturnType<typeof createFakeHerdrCore>; proof?: (nonce: string) => unknown;
  /** Pipe through the real desktop-side guard with this home, as Electron does. */
  guardHome?: string;
  /** The owner's consent the guard asks (spec 2716, D2); none means nothing is asked. */
  consent?: import("../../../desktop/src/main/desktop-link/consent").DesktopLinkConsent;
  staleBytes?: boolean;
}) {
  const socket = new WebSocket(`ws://${base}/ws/desktop-link`, { headers: options.headers ?? ownerHeaders() });
  const control: Array<Record<string, unknown>> = [];
  let closeCode: number | null = null;
  let upgradeStatus: number | null = null;
  let stream: {
    id: number; pipe: ReturnType<ReturnType<typeof createFakeHerdrCore>["connect"]>;
    guard: ReturnType<typeof createDesktopLinkGuard> | null; queue: Promise<void>;
  } | null = null;
  socket.on("unexpected-response", (_request, response) => { upgradeStatus = response.statusCode ?? null; socket.terminate(); });
  socket.on("error", () => {});
  socket.on("message", (data, isBinary) => {
    if (isBinary) {
      const current = stream;
      if (!current) return;
      const bytes = Buffer.from(data as Buffer);
      if (!current.guard) { current.pipe.write(bytes); return; }
      const guard = current.guard;
      current.queue = current.queue.then(async () => {
        // The guard writes what it lets through to the core itself, as in Electron.
        const result = await guard.push(bytes);
        for (const answer of result.toComputer) socket.send(answer);
        // Calls the owner decides later land when decided, as Electron's service does.
        for (const later of result.deferred ?? []) {
          void later.then((decided) => {
            for (const answer of decided.toComputer) socket.send(answer);
          });
        }
      });
      return;
    }
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
      // Through the real guard, as Electron does, both ways: the core's answers are rebuilt too.
      const guard = options.guardHome ? createDesktopLinkGuard({
        home: options.guardHome, computerName: "matrix-demo", ...(options.consent ? { consent: options.consent } : {}),
      }) : null;
      guard?.connect((bytes) => pipe.write(bytes));
      pipe.on("data", (chunk: Buffer) => {
        if (stream?.id !== id) return;
        for (const out of guard ? guard.fromCore(chunk) : [chunk]) socket.send(out);
      });
      pipe.on("close", () => { if (stream?.id === id) { stream = null; socket.send(JSON.stringify({ t: "end", stream: id })); } });
      // Late bytes from an older stream, as a slow reply would arrive: the gateway must drop them.
      if (options.staleBytes) socket.send(Buffer.from("stale reply from an older stream\n"));
      socket.send(JSON.stringify({ t: "opened", stream: id }));
      stream = {
        id, pipe, queue: Promise.resolve(), guard,
      };
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

