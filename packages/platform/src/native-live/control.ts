import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { z } from "zod/v4";
import { WebSocket, WebSocketServer } from "ws";
import { getRunningUserMachineByHandle, type PlatformDB, type UserMachineRecord } from "../db.js";
import { buildPlatformSpeechRuntimeVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import { getRuntimeEntitlementDecisionForUser } from "../runtime-entitlement.js";
import { createNativeLiveFunding } from "./funding.js";
import { constrainNativeLiveSetup, LiveUsageSchema, loadNativeLivePolicy } from "./policy.js";

const GOOGLE_LIVE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const Handle = z.string().regex(/^[a-z][a-z0-9-]{2,30}$/);
const Query = z.object({ runtimeSlot: z.string().min(1).max(80).regex(/^[a-z0-9][a-z0-9_-]*$/) }).strict();
const TextParts = z.array(z.object({ text: z.string().max(16_000) }).strict()).min(1).max(2);
const ClientFrame = z.union([
  z.object({ setup: z.unknown() }).strict(),
  z.object({ clientContent: z.object({ turns: z.array(z.object({ role: z.enum(["user", "model"]), parts: TextParts }).strict()).max(20), turnComplete: z.boolean().optional() }).strict() }).strict(),
  z.object({ realtimeInput: z.object({ audio: z.object({ data: z.string().min(1).max(350_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), mimeType: z.literal("audio/pcm;rate=16000") }).strict().optional(), audioStreamEnd: z.boolean().optional(), text: z.string().max(16_000).optional() }).strict() }).strict(),
  z.object({ toolResponse: z.object({ functionResponses: z.array(z.object({ id: z.string().max(128), name: z.enum(["delegate_task", "find_chats", "check_task", "remember"]), response: z.record(z.string(), z.unknown()) }).strict()).max(4) }).strict() }).strict(),
]);
const ProviderFrame = z.object({ usageMetadata: LiveUsageSchema.optional() }).passthrough();
function reject(socket: Socket, status = 503) {
  socket.end(`HTTP/1.1 ${status} ${status === 401 ? "Unauthorized" : "Service Unavailable"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Platform-paid Live; provider keys and monetary authority stay here.
 * No frame contents are retained in logs or accounting. All usage is an
 * internal conservative platform expense; no user wallet is touched.
 */
export function createNativeLiveControl(options: {
  db: PlatformDB; env: NodeJS.ProcessEnv; platformSecret: string;
  entitled?: (machine: UserMachineRecord) => Promise<boolean>;
  providerUrl?: string;
}) {
  const policy = loadNativeLivePolicy(options.env);
  const funding = policy ? createNativeLiveFunding({ db: options.db, policy }) : undefined;
  const entitled = options.entitled ?? (async (machine: UserMachineRecord) =>
    (await getRuntimeEntitlementDecisionForUser(options.db, machine.clerkUserId, options.env, machine.runtimeSlot, machine.provisioningClass)).runtimeProxyAllowed);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  const sessions = new Map<string, { close(): Promise<void> }>(); // bounded by durable global admission + local policy cap, TTL and explicit shutdown
  const upgrades = new Set<Promise<boolean>>(); // at most 20 in-progress upgrades; drained before database destruction
  let stopped = false;
  const log = (error: unknown) => console.warn("[native-live] operation failed", error instanceof Error ? error.name : "UnknownError");
  async function authenticate(handle: string, rawQuery: URLSearchParams, authorization: string | undefined) {
    const query = Query.safeParse(Object.fromEntries(rawQuery));
    if (!Handle.safeParse(handle).success || !query.success || !options.platformSecret) return undefined;
    const machine = await getRunningUserMachineByHandle(options.db, handle, query.data.runtimeSlot);
    if (!machine || machine.activationState !== "authorized") return undefined;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    const expected = buildPlatformSpeechRuntimeVerificationToken({ handle, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch);
    return timingSafeTokenEquals(token, expected) ? machine : undefined;
  }
  const enabled = (handle: string) => !stopped && !!options.env.GEMINI_API_KEY && !!policy?.allowedHandles.includes(handle);
  const routes = new Hono();
  routes.get("/internal/containers/:handle/native-live/capabilities", async c => {
    c.header("Cache-Control", "no-store, private");
    try {
      const handle = c.req.param("handle");
      const machine = await authenticate(handle, new URL(c.req.url).searchParams, c.req.header("authorization"));
      if (!machine) return c.json({ available: false }, 401);
      if (!enabled(handle) || !funding || !await entitled(machine) || !await funding.available(handle)) return c.json({ available: false });
      return c.json({ available: true, ownerId: machine.clerkUserId, maximumSessionMs: policy!.maximumSessionMs });
    } catch (error: unknown) { log(error); return c.json({ available: false }, 503); }
  });
  const upgrade = async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> => {
      const url = new URL(req.url ?? "/", "http://internal");
      const match = url.pathname.match(/^\/internal\/containers\/([^/]+)\/native-live$/);
      if (!match) return false;
      socket.on("error", log);
      const handle = match[1]!;
      let sessionId: string | undefined;
      try {
        const machine = await authenticate(handle, url.searchParams, req.headers.authorization);
        if (!machine) { reject(socket, 401); return true; }
        if (!enabled(handle) || !funding || !policy || !await entitled(machine) || stopped || sessions.size >= policy.maximumActiveSessions) { reject(socket); return true; }
        sessionId = `live_${randomUUID().replaceAll("-", "")}`;
        const reservation = await funding.reserve(handle, sessionId);
        if (stopped || socket.destroyed || reservation.ownerId !== machine.clerkUserId || reservation.runtimeSlot !== machine.runtimeSlot) {
          await funding.finish(sessionId); reject(socket); return true;
        }
        const id = sessionId;
        wss.handleUpgrade(req, socket, head, client => {
          const provider = new WebSocket(options.providerUrl ?? GOOGLE_LIVE, {
            headers: { "x-goog-api-key": options.env.GEMINI_API_KEY! }, maxPayload: 512 * 1024,
            perMessageDeflate: false, handshakeTimeout: 10_000,
          });
          let closed = false, setupSent = false, touched = Date.now(), pending = 0;
          let chain = Promise.resolve(), closure: Promise<void> | undefined;
          let heartbeatFlight: Promise<void> | undefined;
          const queued: string[] = []; // max 16 frames / 256 KiB until handshake
          let queuedBytes = 0;
          const close = () => {
            if (closure) return closure;
            closed = true; clearTimeout(deadline); clearInterval(heartbeat);
            queued.length = 0; queuedBytes = 0;
            client.terminate(); provider.terminate();
            closure = Promise.allSettled([chain, heartbeatFlight]).then(() => funding.finish(id)).catch(log).finally(() => sessions.delete(id));
            return closure;
          };
          const schedule = (work: () => Promise<void>) => {
            if (closed) return;
            if (++pending > 32) { void close(); return; }
            // Once accepted, accounting must drain even after a cost limit or
            // disconnect closes media. Otherwise later usage hides overruns.
            chain = chain.then(work).catch((error: unknown) => { log(error); void close(); }).finally(() => { pending--; });
          };
          const send = (text: string) => {
            if (provider.bufferedAmount > 256 * 1024) { void close(); return; }
            if (provider.readyState === WebSocket.OPEN) provider.send(text);
            else if (provider.readyState === WebSocket.CONNECTING && queued.length < 16 && queuedBytes + Buffer.byteLength(text) <= 256 * 1024) { queued.push(text); queuedBytes += Buffer.byteLength(text); }
            else void close();
          };
          const deadline = setTimeout(() => { void close(); }, Math.max(1, Date.parse(reservation.expiresAt) - Date.now())); deadline.unref();
          let checking = false;
          const heartbeat = setInterval(() => {
            if (closed || checking) return;
            if (Date.now() - touched > 60_000) { void close(); return; }
            checking = true;
            heartbeatFlight = authenticate(handle, url.searchParams, req.headers.authorization).then(async current => {
              if (!current || !enabled(handle) || !await entitled(current)) { void close(); return; }
              if (!closed) client.ping();
            }).catch((error: unknown) => { log(error); void close(); }).finally(() => { checking = false; });
          }, 20_000); heartbeat.unref();
          sessions.set(id, { close });
          client.on("pong", () => { touched = Date.now(); });
          client.on("message", (data, binary) => {
            if (closed) return;
            touched = Date.now();
            try {
              if (binary) throw new Error("Invalid Live frame");
              const frame = ClientFrame.parse(JSON.parse(data.toString()));
              if ("setup" in frame) {
                if (setupSent) throw new Error("Repeated setup");
                setupSent = true; send(JSON.stringify({ setup: constrainNativeLiveSetup(frame.setup) }));
              } else { if (!setupSent) throw new Error("Setup required"); send(JSON.stringify(frame)); }
            } catch (error: unknown) { log(error); void close(); }
          });
          client.on("close", () => { void close(); }); client.on("error", () => { void close(); });
          provider.on("open", () => { if (closed) return; for (const frame of queued.splice(0)) send(frame); queuedBytes = 0; });
          provider.on("message", (data, binary) => {
            if (closed) return;
            try {
              if (binary) throw new Error("Invalid Live output");
              const frame = ProviderFrame.parse(JSON.parse(data.toString()));
              const usage = frame.usageMetadata;
              if (usage) schedule(async () => { if (!await funding.recordUsage(id, usage)) void close(); });
              if (client.bufferedAmount > 256 * 1024) { void close(); return; }
              if (client.readyState === WebSocket.OPEN) client.send(data, { binary: false });
            } catch (error: unknown) { log(error); void close(); }
          });
          provider.on("close", () => { void close(); }); provider.on("error", (error: unknown) => { log(error); void close(); });
        });
      } catch (error: unknown) {
        log(error); if (sessionId && funding) await funding.finish(sessionId).catch(log); reject(socket);
      }
      return true;
    };
  return {
    routes,
    handleUpgrade(req: IncomingMessage, socket: Socket, head: Buffer) {
      if (!/^\/internal\/containers\/[^/?]+\/native-live(?:\?|$)/.test(req.url ?? "/")) return Promise.resolve(false);
      if (upgrades.size >= 20 || stopped) { reject(socket); return Promise.resolve(true); }
      const pending = upgrade(req, socket, head);
      upgrades.add(pending);
      void pending.finally(() => upgrades.delete(pending));
      return pending;
    },
    async shutdown() {
      stopped = true;
      await Promise.allSettled([...upgrades]);
      await Promise.allSettled([...sessions.values()].map(session => session.close()));
      sessions.clear();
    },
  };
}
