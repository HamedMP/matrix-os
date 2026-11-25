// Desktop link routes (spec 2716): enrolment and machine list over HTTP, and the
// `/ws/desktop-link` socket a desktop opens to this computer. Owner only: the
// computer's owner, signed in with a runtime bearer. Org members,
// collaborators, run-scoped agent tokens and previews are refused.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import {
  DESKTOP_LINK_CLOSE, DESKTOP_LINK_CONTROL_MAX_BYTES, DESKTOP_LINK_PATH,
  DesktopLinkClientFrameSchema, DesktopLinkDeviceIdSchema, DesktopLinkEnrolChallengeRequestSchema, DesktopLinkEnrolChallengeSchema,
  DesktopLinkEnrolRequestSchema, DesktopLinkEnrolmentSchema, DesktopLinkMachineListSchema, DesktopLinkProofFrameSchema,
  desktopLinkEnrolProofMessage, desktopLinkProofMessage, desktopLinkRevisionTag,
} from "@matrix-os/contracts/desktop-link";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer, isLocalTerminalAgent, SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import { createDesktopLink, type DesktopLink } from "./link.js";
import { createChallengeStore, newNonce, verifyDeviceProof } from "./proof.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "./registry.js";
import { DesktopLinkStore, type DesktopLinkDatabase } from "./store.js";
import { addDesktopLinkTerminalRoutes, type DesktopTerminalVerbs, type DesktopTerminalWaiter } from "./terminal-routes.js";

export const DESKTOP_LINK_API_PREFIX = "/api/desktop-link";
const ADMISSION_TIMEOUT_MS = 10_000;
/** The largest binary frame a desktop may send: one herdr-core read, generously. */
export const DESKTOP_LINK_MAX_BINARY_BYTES = 4 * 1024 * 1024;
// Connection attempts, all devices together, per minute. A desktop reconnects with
// backoff; more than this is a loop or abuse.
const MAX_ADMISSIONS_PER_MINUTE = 30;

const smallBody = bodyLimit({ maxSize: 1024, onError: (c) => c.json({ error: "invalid_request" }, 413) });
const enrolBody = bodyLimit({ maxSize: 8 * 1024, onError: (c) => c.json({ error: "invalid_request" }, 413) });

export interface DesktopLinkConfig { ownerId: string; machineId: string }

/** The owner and computer this gateway serves, or null when the Desktop link is off or misconfigured. */
export function readDesktopLinkConfig(env: NodeJS.ProcessEnv = process.env): DesktopLinkConfig | null {
  if (env.MATRIX_DESKTOP_LINK_ENABLED !== "1") return null;
  const ownerId = env.MATRIX_USER_ID ?? env.MATRIX_CLERK_USER_ID;
  const machineId = z.uuid().safeParse(env.MATRIX_MACHINE_ID);
  if (!ownerId || !SAFE_PRINCIPAL_USER_ID.test(ownerId) || !machineId.success) return null;
  return { ownerId, machineId: machineId.data.toLowerCase() };
}

/**
 * True only for the computer's owner signed in with a verified runtime bearer,
 * or a process in one of this computer's own terminals holding the local
 * token, which the auth middleware admits only on the desktop terminal routes.
 */
export function isDesktopLinkOwner(c: Context, ownerId: string): boolean {
  if (!hasVerifiedRuntimeBearer(c)) return false;
  if (isLocalTerminalAgent(c)) return true;
  const principal = getOptionalRequestPrincipal(c);
  // The computer's own shell proxy sends the gateway token with no user named:
  // that resolves to the configured owner, as Herdr's owner routes accept.
  return principal?.userId === ownerId
    && (principal.source === "jwt" || principal.source === "platform-verified" || principal.source === "configured-container");
}

function ownerOnly(ownerId: string): MiddlewareHandler {
  return async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!isDesktopLinkOwner(c, ownerId)) return c.json({ error: "forbidden" }, 403);
    await next();
  };
}

async function parseJson<T>(c: Context, schema: z.ZodType<T>): Promise<T | undefined> {
  if (c.req.header("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return undefined;
  try {
    const parsed = schema.safeParse(await c.req.json());
    return parsed.success ? parsed.data : undefined;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function parseRevisionTag(tag: string | undefined, machineId: string, deviceId: string): number | null {
  const match = tag ? /^"desktop-link-([0-9a-f-]{36})-([0-9a-f]{64})-([1-9][0-9]{0,15})"$/.exec(tag) : null;
  if (!match || match[1] !== machineId || match[2] !== deviceId) return null;
  const revision = Number(match[3]);
  return Number.isSafeInteger(revision) && desktopLinkRevisionTag({ machineId, deviceId, revision }) === tag ? revision : null;
}

function wsText(data: unknown): string | null {
  return typeof data === "string" ? data : null;
}

function wsBinary(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export interface RegisterDesktopLinkOptions {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  ownerDatabase: Kysely<DesktopLinkDatabase> | null;
  config: DesktopLinkConfig | null;
  now?: () => number;
  registry?: DesktopLinkRegistry;
  log?: (message: string) => void;
  /** Terminal verbs and waits (2692), for keys, interrupt and wait on desktop terminals. */
  verbs?: DesktopTerminalVerbs;
  waiter?: DesktopTerminalWaiter;
}

/**
 * Registers the routes synchronously, so they sit in the router where the
 * caller puts them. The store bootstraps in the background; until it is ready
 * (or if it fails) every route answers 503. Returns the registry, or null when
 * the Desktop link is off (routes absent, 404) or there is no owner database (503).
 */
export function registerDesktopLinkRoutes(options: RegisterDesktopLinkOptions): DesktopLinkRegistry | null {
  const { app } = options;
  const config = options.config;
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  const now = options.now ?? Date.now;
  if (!config) return null;
  const { ownerId, machineId } = config;
  const owner = ownerOnly(ownerId);
  const unavailable = (c: Context) => c.json({ error: "unavailable" }, 503);
  const api = new Hono();
  api.use("*", owner);
  api.onError((error, c) => {
    log(`request failed: ${error.name}`);
    return unavailable(c);
  });
  app.use(DESKTOP_LINK_PATH, owner);

  if (!options.ownerDatabase) {
    api.all("*", unavailable);
    app.route(DESKTOP_LINK_API_PREFIX, api);
    app.get(DESKTOP_LINK_PATH, unavailable);
    return null;
  }
  const store = new DesktopLinkStore(options.ownerDatabase, config);
  const ready = store.bootstrap().then(() => true, (error: unknown) => {
    log(`store unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);
    return false;
  });
  const whenReady: MiddlewareHandler = async (c, next) => {
    if (!await ready) return unavailable(c);
    await next();
  };
  api.use("*", whenReady);
  app.use(DESKTOP_LINK_PATH, whenReady);
  const devices = store;
  const registry = options.registry ?? createDesktopLinkRegistry({ now });
  registry.observeSeen((deviceId) => {
    devices.touch(deviceId, new Date(now())).catch((error: unknown) => {
      log(`last-seen update failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    });
  });
  const challenges = createChallengeStore({ now });
  const admissions: number[] = [];

  // --- Enrolment and machines ---------------------------------------------

  api.post("/enrol/challenge", smallBody, async (c) => {
    const request = await parseJson(c, DesktopLinkEnrolChallengeRequestSchema);
    if (!request) return c.json({ error: "invalid_request" }, 400);
    const challenge = challenges.issue(request.deviceId);
    if (!challenge) return c.json({ error: "busy" }, 429);
    return c.json(DesktopLinkEnrolChallengeSchema.parse({ ...challenge, machineId: config.machineId }));
  });

  api.post("/enrol", enrolBody, async (c) => {
    const request = await parseJson(c, DesktopLinkEnrolRequestSchema);
    if (!request) return c.json({ error: "invalid_request" }, 400);
    const challenge = challenges.consume(request.nonce);
    const message = challenge
      ? desktopLinkEnrolProofMessage({ ownerId: config.ownerId, machineId: config.machineId, deviceId: challenge.deviceId, nonce: challenge.nonce })
      : "";
    if (!challenge || !verifyDeviceProof(challenge.deviceId, request.publicKey, request.signature, message)) {
      return c.json({ error: "denied" }, 403);
    }
    const result = await devices.enrol({ deviceId: challenge.deviceId, publicKey: request.publicKey, name: request.name, now: new Date(now()) });
    if (!result.ok) return c.json({ error: result.reason }, 409);
    return c.json(DesktopLinkEnrolmentSchema.parse({ deviceId: result.device.deviceId, revision: result.device.revision, machineId: config.machineId }));
  });

  api.get("/machines", async (c) => {
    const listed = await devices.list();
    return c.json(DesktopLinkMachineListSchema.parse({
      machineId,
      machines: listed.map((device) => ({
        deviceId: device.deviceId,
        name: device.name,
        revision: device.revision,
        state: registry.online(device.deviceId) ? "online" : "offline",
        enrolledAt: device.enrolledAt.toISOString(),
        lastSeenAt: device.lastSeenAt?.toISOString() ?? null,
      })),
    }));
  });

  api.delete("/machines/:deviceId", smallBody, async (c) => {
    const device = DesktopLinkDeviceIdSchema.safeParse(c.req.param("deviceId"));
    if (!device.success) return c.json({ error: "invalid_request" }, 400);
    const revision = parseRevisionTag(c.req.header("If-Match"), config.machineId, device.data);
    if (revision === null) return c.json({ error: "precondition_failed" }, 412);
    const next = await devices.revoke(device.data, revision, new Date(now()));
    if (next === null) return c.json({ error: "conflict" }, 409);
    registry.remove(device.data);
    return c.json({ deviceId: device.data, revision: next });
  });

  addDesktopLinkTerminalRoutes(api, registry, { now, log, ...(options.verbs ? { verbs: options.verbs } : {}), ...(options.waiter ? { waiter: options.waiter } : {}) });
  // Hono copies a sub-app's routes when it is mounted, so mount after defining them.
  app.route(DESKTOP_LINK_API_PREFIX, api);

  // --- The link -----------------------------------------------------------

  app.get(DESKTOP_LINK_PATH, options.upgradeWebSocket(() => {
    let nonce = "";
    let link: DesktopLink | null = null;
    let admitting = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = () => { if (timer) clearTimeout(timer); timer = null; };
    const reject = (ws: WSContext, code: number) => { stop(); ws.close(code); };

    async function admit(ws: WSContext, text: string): Promise<void> {
      admitting = true;
      let raw: unknown;
      try { raw = JSON.parse(text); } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        reject(ws, DESKTOP_LINK_CLOSE.policy);
        return;
      }
      const proof = DesktopLinkProofFrameSchema.safeParse(raw);
      if (!proof.success) { reject(ws, DESKTOP_LINK_CLOSE.policy); return; }
      const { deviceId, revision, signature, app: client } = proof.data;
      const key = await devices.readKey(deviceId, revision);
      const message = desktopLinkProofMessage({ ownerId, machineId, deviceId, revision, nonce });
      if (!timer) return; // timed out while reading the key
      if (!key || !verifyDeviceProof(deviceId, key.publicKey, signature, message)) {
        reject(ws, DESKTOP_LINK_CLOSE.auth);
        return;
      }
      const socket = ws.raw as { bufferedAmount?: number } | undefined;
      const admitted = createDesktopLink({
        info: { deviceId, name: key.name, appVersion: client.version, os: client.os },
        transport: {
          sendText: (frame) => ws.send(frame),
          sendBinary: (bytes) => ws.send(new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)),
          bufferedAmount: () => socket?.bufferedAmount ?? 0,
          close: (code) => ws.close(code),
        },
        now,
        log,
      });
      if (!registry.admit(admitted)) { reject(ws, DESKTOP_LINK_CLOSE.rateLimited); return; }
      stop();
      link = admitted;
      admitted.send({ t: "ready" });
    }

    return {
      onOpen(_event, ws) {
        const at = now();
        while (admissions.length > 0 && at - admissions[0]! > 60_000) admissions.shift();
        if (admissions.length >= MAX_ADMISSIONS_PER_MINUTE) { ws.close(DESKTOP_LINK_CLOSE.rateLimited); return; }
        admissions.push(at);
        nonce = newNonce();
        timer = setTimeout(() => { timer = null; ws.close(DESKTOP_LINK_CLOSE.auth); }, ADMISSION_TIMEOUT_MS);
        ws.send(JSON.stringify({ t: "challenge", nonce, machineId }));
      },
      onMessage(event, ws) {
        const text = wsText(event.data);
        if (!link) {
          // Before admission only one small text frame, the proof, is accepted.
          if (admitting || text === null || Buffer.byteLength(text) > DESKTOP_LINK_CONTROL_MAX_BYTES) {
            reject(ws, DESKTOP_LINK_CLOSE.policy);
            return;
          }
          admit(ws, text).catch((error: unknown) => {
            log(`admission failed: ${error instanceof Error ? error.name : "UnknownError"}`);
            reject(ws, DESKTOP_LINK_CLOSE.going);
          });
          return;
        }
        if (text !== null) {
          if (Buffer.byteLength(text) > DESKTOP_LINK_CONTROL_MAX_BYTES) { link.close(DESKTOP_LINK_CLOSE.policy); return; }
          let raw: unknown;
          try { raw = JSON.parse(text); } catch (error: unknown) {
            if (!(error instanceof SyntaxError)) throw error;
            link.close(DESKTOP_LINK_CLOSE.policy);
            return;
          }
          const frame = DesktopLinkClientFrameSchema.safeParse(raw);
          if (!frame.success) { link.close(DESKTOP_LINK_CLOSE.policy); return; }
          link.receiveControl(frame.data);
          return;
        }
        const bytes = wsBinary(event.data);
        if (!bytes || bytes.length > DESKTOP_LINK_MAX_BINARY_BYTES) { link.close(DESKTOP_LINK_CLOSE.policy); return; }
        link.receiveBinary(bytes);
      },
      onClose() {
        stop();
        if (link) registry.closed(link);
      },
      onError() {
        stop();
        if (link) registry.closed(link);
      },
    };
  }));

  return registry;
}
