import {
  CollaborationClientFrameSchema,
  CollaborationIdSchema,
  CollaborationRevisionSchema,
} from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import { z } from "zod/v4";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
import type { CollaborationAuthority } from "./authority.js";
import type { CollaborationEventRegistry } from "./events.js";

const PROOF_HEADER = "x-matrix-collaboration-proof";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 8;
const EventQuerySchema = z.object({ after: CollaborationRevisionSchema.default("0") }).strict();

type EventSession = Awaited<ReturnType<CollaborationEventRegistry["open"]>>;

export function registerCollaborationEventWebSocketRoute(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  verifier: CollaborationActorProofVerifier;
  authority: CollaborationAuthority;
  registry: CollaborationEventRegistry;
  createConnectionId?: () => string;
}): void {
  const createConnectionId = options.createConnectionId ?? randomUUID;
  options.app.get(
    "/ws/collaboration/scopes/:scopeId/events",
    options.upgradeWebSocket((context) => {
      const scopeId = CollaborationIdSchema.parse(context.req.param("scopeId"));
      const query = parseQuery(context);
      let session: EventSession | null = null;
      let socketClosed = false;
      let processing = Promise.resolve();
      const pendingFrames: string[] = [];

      const processFrame = (raw: string, ws: { send(value: string): void; close(code?: number, reason?: string): void }) => {
        processing = processing.then(async () => {
          const frame = CollaborationClientFrameSchema.parse(JSON.parse(raw) as unknown);
          if (!session) return;
          if (frame.type === "heartbeat") {
            session.touch();
            return;
          }
          if (frame.scopeId !== scopeId) throw new Error("scope mismatch");
          await session.resume(Number(frame.sequence), Number(frame.authorityGeneration));
        }).catch((error: unknown) => {
          console.warn("[collaboration-events] client frame rejected", error instanceof Error ? error.name : "UnknownError");
          sendSetupError(ws);
          ws.close(1008, "Invalid frame");
        });
      };

      return {
        onOpen(_event, ws) {
          void (async () => {
            const signedProof = decodeProof(context);
            const proof = await options.verifier.verifySocket({
              signedProof,
              purpose: "events",
              path: context.req.path,
              query: rawQuery(context),
            });
            if (proof.scopeId !== scopeId) throw new Error("scope mismatch");
            const authorized = await options.authority.authorize({
              scopeId,
              actorId: proof.actorId,
              action: "read",
            });
            if (authorized.ownerId !== proof.ownerId
              || authorized.authorityRuntimeId !== proof.runtimeId) throw new Error("authority mismatch");
            const opened = await options.registry.open({
              connectionId: createConnectionId(),
              scopeId,
              actorId: proof.actorId,
              authorityGeneration: authorized.authorityGeneration,
              afterSequence: Number(query.after),
              socket: ws,
            });
            if (socketClosed) {
              opened.close();
              return;
            }
            session = opened;
            for (const frame of pendingFrames.splice(0)) processFrame(frame, ws);
          })().catch((error: unknown) => {
            console.warn("[collaboration-events] socket setup failed", error instanceof Error ? error.name : "UnknownError");
            pendingFrames.splice(0);
            if (socketClosed) return;
            sendSetupError(ws);
            ws.close(1008, "Unavailable");
          });
        },
        onMessage(event, ws) {
          const raw = frameText(event.data);
          if (raw === null) {
            sendSetupError(ws);
            ws.close(1008, "Invalid frame");
            return;
          }
          if (session) {
            processFrame(raw, ws);
            return;
          }
          if (pendingFrames.length >= MAX_PENDING_FRAMES) {
            sendSetupError(ws);
            ws.close(1008, "Invalid frame");
            return;
          }
          pendingFrames.push(raw);
        },
        onClose() {
          socketClosed = true;
          pendingFrames.splice(0);
          session?.close();
          session = null;
        },
      };
    }),
  );
}

function parseQuery(context: Context): z.infer<typeof EventQuerySchema> {
  const params = new URL(context.req.url).searchParams;
  const keys = [...params.keys()];
  if (keys.some((key) => key !== "after") || keys.filter((key) => key === "after").length > 1) {
    throw new SyntaxError("Invalid event cursor");
  }
  return EventQuerySchema.parse(Object.fromEntries(params.entries()));
}

function rawQuery(context: Context): string {
  return new URL(context.req.url).search.slice(1);
}

function decodeProof(context: Context): unknown {
  const value = context.req.header(PROOF_HEADER);
  if (!value || value.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid proof");
  }
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function frameText(value: unknown): string | null {
  if (typeof value === "string") {
    return Buffer.byteLength(value) <= MAX_FRAME_BYTES ? value : null;
  }
  if (value instanceof ArrayBuffer) {
    return value.byteLength <= MAX_FRAME_BYTES ? new TextDecoder().decode(value) : null;
  }
  if (ArrayBuffer.isView(value)) {
    return value.byteLength <= MAX_FRAME_BYTES
      ? new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      : null;
  }
  return null;
}

function sendSetupError(ws: { send(value: string): void }): void {
  try {
    ws.send(JSON.stringify({ version: 1, type: "collaboration.error", code: "unavailable" }));
  } catch (error: unknown) {
    console.warn("[collaboration-events] socket error send failed", error instanceof Error ? error.name : "UnknownError");
  }
}
