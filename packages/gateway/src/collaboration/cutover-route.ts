/** Authenticated platform command ingress for one owner-home cutover phase. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod/v4";
import { GatewayCutoverError, type GatewayCollaborationCutover, type GatewayCutoverKey } from "./cutover.js";
import { DirectReplayCache, type DirectSigningKey } from "./direct-auth.js";
import { canonicalJson, verifyEd25519 } from "./direct-crypto.js";

const DOMAIN = "matrix-collaboration-cutover-v1";
const MAX_BODY_BYTES = 4_096;
const MAX_COMMAND_MS = 30_000;
const CLOCK_SKEW_MS = 5_000;
const Id = z.uuid();
const Phase = z.enum(["inventory", "freeze", "drain", "stage", "verify", "activate", "rollback-compatible", "disable"]);
const Command = z.object({
  version: z.literal(1),
  scopeId: Id,
  ownerId: z.string().min(1).max(128),
  organizationId: z.string().min(1).max(128),
  runtimeId: z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/),
  expectedSourceGeneration: z.number().int().positive(),
  targetGeneration: z.number().int().positive(),
  idempotencyKey: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
  phase: Phase,
  method: z.literal("POST"),
  path: z.string().min(1).max(256),
  nonce: Id,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
}).strict();
const Envelope = z.object({
  command: Command,
  keyId: z.string().min(1).max(80).regex(/^[A-Za-z0-9_.-]+$/),
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

export type CollaborationCutoverCommand = z.infer<typeof Command>;
export type CollaborationCutoverEnvelope = z.infer<typeof Envelope>;

export interface CollaborationCutoverRouteOptions {
  ownerId: string;
  runtimeId: string;
  platformKeys(): readonly DirectSigningKey[];
  controlFresh(): boolean;
  cutover: Pick<GatewayCollaborationCutover,
    "inventory" | "freeze" | "drain" | "stage" | "verify" | "activate" | "rollbackCompatible" | "disable">;
  drainRuns(key: GatewayCutoverKey): Promise<{ interrupted: number; remaining: number }>;
  replay?: DirectReplayCache;
  now?: () => Date;
}

function responseError(code: "invalid_request" | "forbidden" | "unavailable" | "conflict", status: 401 | 403 | 409 | 413 | 503) {
  return { body: { error: "Collaboration cutover unavailable", code }, status } as const;
}

/** The global home bearer middleware also applies to this internal path. */
export function createCollaborationCutoverRoutes(options: CollaborationCutoverRouteOptions): Hono {
  const routes = new Hono();
  const replay = options.replay ?? new DirectReplayCache({ maxEntries: 2_048, now: options.now });
  const now = options.now ?? (() => new Date());
  routes.post("/internal/collaboration/cutover/:scopeId/:phase",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json(responseError("invalid_request", 413).body, 413) }),
    async (c) => {
      const parsedPathScope = Id.safeParse(c.req.param("scopeId"));
      const parsedPhase = Phase.safeParse(c.req.param("phase"));
      if (!parsedPathScope.success || !parsedPhase.success) return c.json(responseError("invalid_request", 401).body, 401);
      let raw: unknown;
      try { raw = await c.req.json(); }
      catch (error: unknown) {
        if (error instanceof Error && error.name === "BodyLimitError") {
          return c.json(responseError("invalid_request", 413).body, 413);
        }
        if (!(error instanceof SyntaxError)) console.warn("[collaboration-cutover] invalid body", error instanceof Error ? error.name : "UnknownError");
        return c.json(responseError("invalid_request", 401).body, 401);
      }
      const parsed = Envelope.safeParse(raw);
      if (!parsed.success) return c.json(responseError("invalid_request", 401).body, 401);
      const { command, keyId, signature } = parsed.data;
      if (command.scopeId !== parsedPathScope.data || command.phase !== parsedPhase.data
        || command.path !== c.req.path || command.ownerId !== options.ownerId
        || command.runtimeId !== options.runtimeId || command.targetGeneration <= command.expectedSourceGeneration) {
        return c.json(responseError("forbidden", 403).body, 403);
      }
      if (!options.controlFresh()) return c.json(responseError("unavailable", 503).body, 503);
      const issuedAt = Date.parse(command.issuedAt);
      const expiresAt = Date.parse(command.expiresAt);
      const current = now().getTime();
      if (issuedAt > current + CLOCK_SKEW_MS || expiresAt <= current
        || expiresAt - issuedAt > MAX_COMMAND_MS || current - issuedAt > MAX_COMMAND_MS + CLOCK_SKEW_MS) {
        return c.json(responseError("invalid_request", 401).body, 401);
      }
      const key = options.platformKeys().find((entry) => entry.keyId === keyId && entry.algorithm === "ed25519");
      if (!key || !verifyEd25519(key.publicKey, `${DOMAIN}\n${canonicalJson(command)}`, signature)) {
        return c.json(responseError("invalid_request", 401).body, 401);
      }
      const replayResult = replay.admit(`${keyId}:${command.nonce}`, expiresAt + CLOCK_SKEW_MS);
      if (replayResult === "replayed") return c.json(responseError("conflict", 409).body, 409);
      if (replayResult === "unretainable") return c.json(responseError("unavailable", 503).body, 503);
      const cutoverKey: GatewayCutoverKey = {
        scopeId: command.scopeId, ownerId: command.ownerId, organizationId: command.organizationId,
        runtimeId: command.runtimeId, expectedSourceGeneration: command.expectedSourceGeneration,
        targetGeneration: command.targetGeneration, idempotencyKey: command.idempotencyKey,
      };
      try {
        const result = command.phase === "inventory" ? await options.cutover.inventory(cutoverKey)
          : command.phase === "freeze" ? await options.cutover.freeze(cutoverKey)
          : command.phase === "drain" ? await options.cutover.drain(cutoverKey, () => options.drainRuns(cutoverKey))
          : command.phase === "stage" ? await options.cutover.stage(cutoverKey)
          : command.phase === "verify" ? await options.cutover.verify(cutoverKey)
          : command.phase === "activate" ? await options.cutover.activate(cutoverKey)
          : command.phase === "rollback-compatible" ? await options.cutover.rollbackCompatible(cutoverKey, { compatibleDirectBuild: true })
          : await options.cutover.disable(cutoverKey);
        c.header("Cache-Control", "no-store");
        return c.json(result);
      } catch (error: unknown) {
        if (error instanceof GatewayCutoverError) {
          const status = error.code === "conflict" || error.code === "non_organization" ? 409
            : error.code === "not_found" ? 404 : 503;
          return c.json({ error: "Collaboration cutover unavailable", code: error.code }, status);
        }
        console.warn("[collaboration-cutover] phase failed", error instanceof Error ? error.name : "UnknownError");
        return c.json(responseError("unavailable", 503).body, 503);
      }
    });
  return routes;
}
