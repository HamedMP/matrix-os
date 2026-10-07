import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod/v4";
import { getRunningUserMachineByHandle, type PlatformDB } from "../db.js";
import { RuntimeSlotSchema } from "../customer-vps-schema.js";
import { buildPlatformSpeechRuntimeVerificationToken, timingSafeTokenEquals } from "../platform-token.js";
import { rejectWebSocketUpgrade } from "../websocket-upgrade-rejection.js";
import { AoedeLiveError, LiveMintInput, LiveProviderId, type PlatformAoedeLiveService } from "./service.js";

const Handle = z.string().min(1).max(63).regex(/^[a-z0-9][a-z0-9-]*$/);
const Query = z.object({ runtimeSlot: RuntimeSlotSchema }).strict();
const errorBody = { error: { code: "unavailable", message: "Voice session unavailable" } };
export async function authenticateAoedeRuntime(options: { db: PlatformDB; platformSecret: string },
  handle: unknown, url: string, authorization?: string) {
  const parsedHandle = Handle.safeParse(handle);
  const query = Query.safeParse(Object.fromEntries(new URL(url, "https://platform.invalid").searchParams));
  if (!parsedHandle.success || !query.success || options.platformSecret.length < 32) return undefined;
  const machine = await getRunningUserMachineByHandle(options.db, parsedHandle.data, query.data.runtimeSlot);
  if (!machine) return undefined;
  const expected = buildPlatformSpeechRuntimeVerificationToken({ handle: parsedHandle.data, machineId: machine.machineId,
    runtimeSlot: machine.runtimeSlot }, options.platformSecret, machine.runtimeTokenEpoch);
  if (!timingSafeTokenEquals(authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined, expected)) return undefined;
  return { ownerId: machine.clerkUserId, machineId: machine.machineId, runtimeSlot: machine.runtimeSlot,
    runtimeTokenEpoch: machine.runtimeTokenEpoch };
}

export function createAoedeLiveRuntimeRoutes(options: { db: PlatformDB; platformSecret: string; service?: PlatformAoedeLiveService }) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store, private"); c.header("CDN-Cache-Control", "no-store");
    c.header("Cloudflare-CDN-Cache-Control", "no-store");
    await next();
  });
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json(errorBody, 413) }));
  const authenticate = (c: import("hono").Context) => authenticateAoedeRuntime(options, c.req.param("handle"), c.req.url, c.req.header("authorization"));
  app.post("/session", async (c) => {
    try {
      const identity = await authenticate(c);
      if (!identity) return c.json(errorBody, 401);
      const input = LiveMintInput.safeParse(await c.req.json());
      if (!input.success) return c.json(errorBody, 400);
      if (!options.service) return c.json(errorBody, 503);
      return c.json(await options.service.mint(identity, input.data, c.req.raw.signal), 201);
    } catch (error) { return c.json(errorBody, error instanceof Error && error.name === "BodyLimitError" ? 413
      : error instanceof SyntaxError ? 400 : error instanceof AoedeLiveError && error.code === "conflict" ? 409 : 503); }
  });
  app.delete("/sessions/:id", async (c) => {
    try {
      const identity = await authenticate(c);
      if (!identity) return c.json(errorBody, 401);
      const id = LiveProviderId.safeParse(c.req.param("id"));
      if (!id.success || (await c.req.text()).length > 0) return c.json(errorBody, 400);
      if (!options.service) return c.json(errorBody, 503);
      return c.json(await options.service.close(identity, id.data), 200);
    } catch (error) { return c.json(errorBody, error instanceof Error && error.name === "BodyLimitError" ? 413
      : error instanceof AoedeLiveError && error.code === "not_found" ? 404 : 503); }
  });
  return app;
}

export function createAoedeLiveUpgradeHandler(options: { db: PlatformDB; platformSecret: string; service?: PlatformAoedeLiveService }) {
  const server = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024, perMessageDeflate: false });
  server.on("headers", (headers) => { headers.push("Cache-Control: no-store, private"); });
  return async (req: IncomingMessage, socket: Socket, head: Buffer): Promise<boolean> => {
    const path = new URL(req.url ?? "/", "https://platform.invalid").pathname;
    if (!path.startsWith("/internal/containers/") || !path.includes("/aoede/")) return false;
    const match = /^\/internal\/containers\/([^/]+)\/aoede\/sessions\/([^/]+)\/attach$/.exec(path);
    let binding: Awaited<ReturnType<PlatformAoedeLiveService["bind"]>> | undefined;
    let expired = false;
    const timeout = setTimeout(() => { expired = true; rejectWebSocketUpgrade(socket, 503); }, 10_000);
    try {
      if (!match || !LiveProviderId.safeParse(match[2]).success) { rejectWebSocketUpgrade(socket, 400); return true; }
      const identity = await authenticateAoedeRuntime(options, match[1], req.url!, typeof req.headers.authorization === "string" ? req.headers.authorization : undefined);
      if (!identity) { rejectWebSocketUpgrade(socket, 401); return true; }
      if (!options.service) { rejectWebSocketUpgrade(socket, 503); return true; }
      binding = await options.service.bind(identity, match[2]);
      if (expired || socket.destroyed) { binding.release(); return true; }
      server.handleUpgrade(req, socket, head, (client) => {
        const release = () => { binding!.release(); client.terminate(); };
        client.once("close", () => binding!.release()); client.once("error", release);
        binding!.subscribe((event) => {
          if (client.readyState !== WebSocket.OPEN || client.bufferedAmount > 512 * 1024) { release(); return; }
          client.send(event, (error) => { if (error) release(); });
          if (JSON.parse(event).type === "session.closed") client.close();
        }, release);
        client.on("message", (raw, binary) => {
          try { if (binary) throw new AoedeLiveError(); binding!.send(raw.toString()); }
          catch (error) {
            console.warn("[aoede-live] control frame rejected", error instanceof Error ? error.name : "UnknownError");
            release();
          }
        });
      });
    } catch (error) {
      binding?.release();
      rejectWebSocketUpgrade(socket, error instanceof AoedeLiveError && error.code === "not_found" ? 404 : 503);
    } finally { clearTimeout(timeout); }
    return true;
  };
}
