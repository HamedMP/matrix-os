import {
  CollaborationClientFrameSchema,
  CollaborationIdSchema,
  CollaborationTerminalActionSchema,
} from "@matrix-os/contracts";
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { UpgradeWebSocket } from "hono/ws";
import type { CollaborationActorProofVerifier } from "./actor-proof.js";
import type { CollaborationAuthority } from "./authority.js";
import type { TerminalControlCoordinator } from "./terminal-control.js";
import type { CollaborationTerminalDispatcher } from "./terminal-dispatcher.js";
import type { CollaborationTerminalEventRegistry } from "./terminal-events.js";

const PROOF_HEADER = "x-matrix-collaboration-proof";
const POLICY_HEADER = "x-matrix-collaboration-policy";
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_FRAMES = 8;

type TerminalSession = Awaited<ReturnType<CollaborationTerminalEventRegistry["open"]>>;

export function registerCollaborationTerminalWebSocketRoute(options: {
  app: Hono;
  upgradeWebSocket: UpgradeWebSocket;
  verifier: CollaborationActorProofVerifier;
  authority: CollaborationAuthority;
  dispatcher: CollaborationTerminalDispatcher;
  registry: CollaborationTerminalEventRegistry;
  control: TerminalControlCoordinator;
  createConnectionId?: () => string;
  now?: () => Date;
}): void {
  const createConnectionId = options.createConnectionId
    ?? (() => `connection_${randomUUID().replaceAll("-", "")}`);
  options.app.get(
    "/ws/collaboration/scopes/:scopeId/terminal",
    options.upgradeWebSocket((context) => {
      const scopeId = CollaborationIdSchema.parse(context.req.param("scopeId"));
      let session: TerminalSession | null = null;
      let actorId: string | null = null;
      let connectionId: string | null = null;
      let policyExpiry: ReturnType<typeof setTimeout> | null = null;
      let socketClosed = false;
      let processing = Promise.resolve();
      const pendingFrames: string[] = [];

      const processFrame = (raw: string, ws: { send(value: string): void; close(code?: number, reason?: string): void }) => {
        processing = processing.then(async () => {
          if (!session || !actorId || !connectionId) return;
          const parsed = JSON.parse(raw) as unknown;
          const lifecycle = CollaborationClientFrameSchema.safeParse(parsed);
          if (lifecycle.success && lifecycle.data.type === "heartbeat") {
            session.touch();
            return;
          }
          const action = CollaborationTerminalActionSchema.parse(parsed);
          const policy = options.verifier.verifyPolicy(decodeHeader(context, POLICY_HEADER));
          requireM3Policy(policy, actorId);
          await options.dispatcher.dispatch({ scopeId, actorId, connectionId, policy, action });
          await options.registry.publishState(scopeId);
          session.touch();
        }).catch((error: unknown) => {
          console.warn("[collaboration-terminal-ws] client frame rejected", error instanceof Error ? error.name : "UnknownError");
          sendError(ws);
          ws.close(1008, "Invalid frame");
        });
      };

      return {
        onOpen(_event, ws) {
          void (async () => {
            const proof = await options.verifier.verifySocket({
              signedProof: decodeHeader(context, PROOF_HEADER),
              purpose: "terminal",
              path: context.req.path,
              query: "",
            });
            if (proof.scopeId !== scopeId) throw new Error("scope mismatch");
            const policy = options.verifier.verifyPolicy(decodeHeader(context, POLICY_HEADER));
            requireM3Policy(policy, proof.actorId, proof.ownerId);
            const authorized = await options.authority.authorize({
              scopeId,
              actorId: proof.actorId,
              action: "read",
            });
            if (authorized.ownerId !== proof.ownerId || authorized.authorityRuntimeId !== proof.runtimeId
              || authorized.resourceKind !== "terminal") throw new Error("authority mismatch");
            const nextConnectionId = createConnectionId();
            const opened = await options.registry.open({
              connectionId: nextConnectionId,
              scopeId,
              actorId: proof.actorId,
              authorityGeneration: authorized.authorityGeneration,
              socket: {
                send: (value) => { ws.send(value); },
                close: (code, reason) => { ws.close(code, reason); },
                get bufferedAmount() { return rawBufferedAmount(ws.raw); },
              },
            });
            if (socketClosed) {
              opened.close();
              return;
            }
            actorId = proof.actorId;
            connectionId = nextConnectionId;
            session = opened;
            const currentTime = options.now?.().getTime() ?? Date.now();
            policyExpiry = setTimeout(() => {
              sendError(ws);
              ws.close(1008, "Policy expired");
            }, Math.max(1, Date.parse(policy.expiresAt) - currentTime));
            policyExpiry.unref?.();
            for (const frame of pendingFrames.splice(0)) processFrame(frame, ws);
          })().catch((error: unknown) => {
            console.warn("[collaboration-terminal-ws] socket setup failed", error instanceof Error ? error.name : "UnknownError");
            pendingFrames.splice(0);
            if (socketClosed) return;
            sendError(ws);
            ws.close(1008, "Unavailable");
          });
        },
        onMessage(event, ws) {
          const raw = frameText(event.data);
          if (raw === null) {
            sendError(ws);
            ws.close(1008, "Invalid frame");
            return;
          }
          if (session) {
            processFrame(raw, ws);
            return;
          }
          if (pendingFrames.length >= MAX_PENDING_FRAMES) {
            sendError(ws);
            ws.close(1008, "Invalid frame");
            return;
          }
          pendingFrames.push(raw);
        },
        onClose() {
          socketClosed = true;
          pendingFrames.splice(0);
          if (policyExpiry) clearTimeout(policyExpiry);
          if (connectionId) options.control.markDisconnected(scopeId, connectionId);
          session?.close();
          session = null;
        },
      };
    }),
  );
}

function requireM3Policy(
  policy: { milestone: string; mode: string; cohort: string[] },
  actorId: string,
  ownerId?: string,
): void {
  if (policy.milestone !== "m3" || policy.mode === "off" || policy.mode === "read_only"
    || (policy.mode === "internal" && (!policy.cohort.includes(actorId)
      || (ownerId !== undefined && !policy.cohort.includes(ownerId))))) throw new Error("policy unavailable");
}

function decodeHeader(context: Context, name: string): unknown {
  const value = context.req.header(name);
  if (!value || value.length > 8_192 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid header");
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
}

function frameText(value: unknown): string | null {
  if (typeof value === "string") return Buffer.byteLength(value) <= MAX_FRAME_BYTES ? value : null;
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

function sendError(ws: { send(value: string): void }): void {
  try {
    ws.send(JSON.stringify({ version: 1, type: "collaboration.error", code: "unavailable" }));
  } catch (error: unknown) {
    console.warn("[collaboration-terminal-ws] socket error send failed", error instanceof Error ? error.name : "UnknownError");
  }
}

function rawBufferedAmount(raw: unknown): number {
  if (!raw || typeof raw !== "object" || !("bufferedAmount" in raw)) return 0;
  const value = Reflect.get(raw, "bufferedAmount");
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
