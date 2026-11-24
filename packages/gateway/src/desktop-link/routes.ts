// Desktop link routes (spec 2716): the machine list over HTTP and the
// `/ws/desktop-link` socket a desktop opens to this computer. A desktop links
// only as the device paired with this computer under 2698, at the current
// pairing revision, proved with its pairing key. Owner only: org members,
// collaborators, run-scoped agent tokens and previews are refused.
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import type { Kysely } from "kysely";
import { z } from "zod/v4";
import { randomBytes } from "node:crypto";
import {
  DESKTOP_LINK_CLOSE, DESKTOP_LINK_CONTROL_MAX_BYTES, DESKTOP_LINK_PATH,
  DesktopLinkClientFrameSchema, DesktopLinkMachineListSchema, DesktopLinkProofFrameSchema, desktopLinkProofMessage,
} from "@matrix-os/contracts/desktop-link";
import { DESKTOP_LINK_SEEN_INTERVAL_MS, DesktopPairingRepository, type DesktopPairingDatabase } from "../desktop-pairing/database.js";
import { verifyDeviceProof } from "../desktop-pairing/proof.js";
import { getOptionalRequestPrincipal, hasVerifiedRuntimeBearer, SAFE_PRINCIPAL_USER_ID } from "../request-principal.js";
import { createDesktopLink, type DesktopLink } from "./link.js";
import { createDesktopLinkRegistry, type DesktopLinkRegistry } from "./registry.js";

export const DESKTOP_LINK_API_PREFIX = "/api/desktop-link";
const ADMISSION_TIMEOUT_MS = 10_000;
/** The largest binary frame a desktop may send: one herdr-core read, generously. */
export const DESKTOP_LINK_MAX_BINARY_BYTES = 4 * 1024 * 1024;
// Connection attempts, all devices together, per minute. A desktop reconnects with
// backoff; more than this is a loop or abuse.
const MAX_ADMISSIONS_PER_MINUTE = 30;

export interface DesktopLinkConfig { ownerId: string; machineId: string }

/**
 * The owner and computer this gateway serves, or null when the desktop link is
 * off or misconfigured. The link rides on 2698 pairing, so it needs the same
 * gate as the pairing routes: pairing on, primary computer, owner, machine id, handle.
 */
export function readDesktopLinkConfig(env: NodeJS.ProcessEnv = process.env): DesktopLinkConfig | null {
  if (env.MATRIX_DESKTOP_LINK_ENABLED !== "1" || env.MATRIX_DESKTOP_PAIRING_ENABLED !== "1") return null;
  if (!env.MATRIX_HANDLE || env.MATRIX_RUNTIME_SLOT !== "primary") return null;
  const ownerId = env.MATRIX_USER_ID ?? env.MATRIX_CLERK_USER_ID;
  const machineId = z.uuid().safeParse(env.MATRIX_MACHINE_ID);
  if (!ownerId || !SAFE_PRINCIPAL_USER_ID.test(ownerId) || !machineId.success) return null;
  return { ownerId, machineId: machineId.data.toLowerCase() };
}

/** The pairing routes' own gate (2698): only a signed-in desktop may open the link. */
function isPairingOwner(c: Context, ownerId: string): boolean {
  if (!hasVerifiedRuntimeBearer(c)) return false;
  const principal = getOptionalRequestPrincipal(c);
  return principal?.userId === ownerId && (principal.source === "jwt" || principal.source === "platform-verified");
}

/** True only for the computer's owner signed in with a verified runtime bearer. */
export function isDesktopLinkOwner(c: Context, ownerId: string): boolean {
  if (!hasVerifiedRuntimeBearer(c)) return false;
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
  /** Owner Postgres holding 2698's `desktop_pairings`, which the pairing routes create. */
  ownerDatabase: Kysely<DesktopPairingDatabase> | null;
  config: DesktopLinkConfig | null;
  now?: () => number;
  registry?: DesktopLinkRegistry;
  log?: (message: string) => void;
}

/**
 * Registers the routes synchronously, so they sit in the router where the
 * caller puts them. Pairing reads that fail (no table yet, database down)
 * answer 503. Returns the registry, or null when the desktop link is off
 * (routes absent, 404) or there is no owner database (503).
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
  app.use(DESKTOP_LINK_PATH, async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!isPairingOwner(c, ownerId)) return c.json({ error: "forbidden" }, 403);
    await next();
  });

  if (!options.ownerDatabase) {
    api.all("*", unavailable);
    app.route(DESKTOP_LINK_API_PREFIX, api);
    app.get(DESKTOP_LINK_PATH, unavailable);
    return null;
  }
  const pairing = new DesktopPairingRepository(options.ownerDatabase, config);
  const registry = options.registry ?? createDesktopLinkRegistry({ now });
  registry.usePairing(() => pairing.read());
  const admissions: number[] = [];
  // When last-seen was last written for the paired device at its revision (D3):
  // at most once a minute. One entry: only the paired desktop links.
  let lastWrite: { key: string; at: number } | null = null;
  registry.observeSeen((link) => {
    const key = `${link.info.deviceId}:${link.info.revision}`;
    const at = now();
    if (lastWrite?.key === key && at - lastWrite.at < DESKTOP_LINK_SEEN_INTERVAL_MS) return;
    lastWrite = { key, at };
    pairing.touch(link.info.deviceId, link.info.revision, new Date(at)).catch((error: unknown) => {
      log(`last-seen update failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    });
  });

  api.get("/machines", async (c) => {
    const state = await pairing.read();
    const deviceId = state.deviceId;
    const stored = deviceId ? await pairing.readReport(deviceId, state.revision) : null;
    const report = stored?.report ?? null;
    return c.json(DesktopLinkMachineListSchema.parse({
      machines: deviceId ? [{
        deviceId,
        name: report?.name ?? "Paired desktop",
        revision: state.revision,
        state: registry.online(deviceId) ? "online" : "offline",
        lastSeenAt: stored?.lastSeenAt?.toISOString() ?? null,
      }] : [],
    }));
  });

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
      const { deviceId, revision, signature, name, app: client } = proof.data;
      // Only the paired device at exactly the current revision (2698).
      const publicKey = await pairing.readRegisteredKey(deviceId, revision);
      const message = desktopLinkProofMessage({ ownerId, machineId, deviceId, revision, nonce });
      if (!timer) return; // timed out while reading the key
      if (!publicKey || !verifyDeviceProof(deviceId, publicKey, signature, message)) {
        reject(ws, DESKTOP_LINK_CLOSE.auth);
        return;
      }
      const socket = ws.raw as { bufferedAmount?: number } | undefined;
      const admitted = createDesktopLink({
        info: { deviceId, revision, name, appVersion: client.version, os: client.os },
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
        nonce = randomBytes(32).toString("base64url");
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
