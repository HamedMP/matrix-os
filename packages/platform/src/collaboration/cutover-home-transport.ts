/** S18 operator transport: signed platform commands to one enrolled owner home. */
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { createGatewayCutoverHomeAdapter, type FlatHomeCutoverClient, type FlatHomeCutoverResult } from "./cutover-home-adapter.js";
import type { CutoverHomeRequest } from "./cutover.js";
import { canonicalJson, ed25519PrivateKeyFromSeed, signEd25519 } from "./ticket-crypto.js";
import type { TicketSigningKeyring } from "./ticket-issuer.js";

const CUTOVER_DOMAIN = "matrix-collaboration-cutover-v1";
const CUTOVER_LIFETIME_MS = 30_000;
const RESPONSE_LIMIT_BYTES = 32 * 1024;
const BEARER_TOKEN = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATIONS = ["inventory", "freeze", "drain", "stage", "verify", "activate", "rollback-compatible", "disable"] as const;
type Operation = typeof OPERATIONS[number];

const FlatResultSchema = z.object({
  scopeId: z.string().regex(UUID), organizationId: z.string().min(1).max(128),
  phase: z.enum(["inventoried", "fenced", "drained", "staged", "verified", "active", "blocked", "rolled_back"]),
  authorityGeneration: z.number().int().positive(),
  legacyCount: z.number().int().min(0).max(1_000_000),
  grantCount: z.number().int().min(0).max(1_000_000),
  invitationCount: z.number().int().min(0).max(1_000_000),
  nonOrganizationCount: z.number().int().min(0).max(1_000_000),
  ceilingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  idsDigest: z.string().regex(/^[a-f0-9]{64}$/),
  backupRef: z.string().min(1).max(256),
  backupInventoryRef: z.string().min(1).max(256),
  fenceEpoch: z.number().int().positive().nullable(),
  fenceDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  interrupted: z.number().int().min(0).max(1_000_000).optional(),
  shadowCount: z.number().int().min(0).max(1_000_000).optional(),
}).strict();

function exactHttpsOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.origin !== value
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Owner-home cutover origin is unavailable");
  }
  return url.origin;
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > RESPONSE_LIMIT_BYTES) throw new Error("Owner-home cutover response is too large");
  if (!response.body) throw new Error("Owner-home cutover response is empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT_BYTES) {
        await reader.cancel();
        throw new Error("Owner-home cutover response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError)) console.warn("[collaboration-cutover] response parse failed", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Owner-home cutover response is invalid");
  }
}

function createHttpClient(options: {
  origin: string;
  bearerToken: string;
  keyring: TicketSigningKeyring;
  fetchImpl: typeof fetch;
  now: () => Date;
}): FlatHomeCutoverClient {
  const origin = exactHttpsOrigin(options.origin);
  if (!BEARER_TOKEN.test(options.bearerToken)) throw new Error("Owner-home cutover bearer is unavailable");
  const keyId = options.keyring.activeKeyId;
  const seed = options.keyring.keys[keyId];
  if (!seed || !/^[A-Za-z0-9_.-]{1,80}$/.test(keyId)) throw new Error("Platform cutover signing key is unavailable");
  const privateKey = ed25519PrivateKeyFromSeed(seed);
  async function invoke(phase: Operation, key: CutoverHomeRequest): Promise<FlatHomeCutoverResult> {
    if (!UUID.test(key.scopeId)) throw new Error("Cutover scope is invalid");
    const path = `/internal/collaboration/cutover/${key.scopeId}/${phase}`;
    const issuedAt = options.now();
    const command = {
      version: 1 as const,
      scopeId: key.scopeId, ownerId: key.ownerId, organizationId: key.organizationId,
      runtimeId: key.runtimeId, expectedSourceGeneration: key.expectedSourceGeneration,
      targetGeneration: key.targetGeneration, idempotencyKey: key.idempotencyKey,
      phase, method: "POST" as const, path,
      nonce: randomUUID(),
      issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.getTime() + CUTOVER_LIFETIME_MS).toISOString(),
    };
    const signature = signEd25519(privateKey, `${CUTOVER_DOMAIN}\n${canonicalJson(command)}`);
    const response = await options.fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json",
        authorization: `Bearer ${options.bearerToken}`,
      },
      body: JSON.stringify({ command, keyId, signature }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Owner-home cutover is unavailable");
    }
    const parsed = FlatResultSchema.safeParse(await boundedJson(response));
    if (!parsed.success) throw new Error("Owner-home cutover response is invalid");
    return parsed.data;
  }
  return {
    inventory: (key) => invoke("inventory", key),
    freeze: (key) => invoke("freeze", key),
    // The operator command crosses processes. The home route injects its own
    // canonical scoped drain callback; JavaScript callbacks never cross HTTP.
    drain: (key) => invoke("drain", key),
    stage: (key) => invoke("stage", key),
    verify: (key) => invoke("verify", key),
    activate: (key) => invoke("activate", key),
    rollbackCompatible: (key) => invoke("rollback-compatible", key),
    disable: (key) => invoke("disable", key),
  };
}

/** Resolve the exact owner runtime before sending any signed command. */
export function createPlatformCutoverHomeResolver(options: {
  keyring: TicketSigningKeyring | null;
  resolveRuntime(input: { scopeId: string; runtimeId: string; ownerId: string }): Promise<
    { status: "ready"; origin: string; bearerToken: string } | { status: "offline" | "ambiguous" }
  >;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}) {
  return async (input: { scopeId: string; runtimeId: string; ownerId: string }) => {
    if (!options.keyring) return { status: "offline" as const };
    const route = await options.resolveRuntime(input);
    if (route.status !== "ready") return route;
    try {
      return {
        status: "ready" as const,
        home: createGatewayCutoverHomeAdapter({
          client: createHttpClient({
            origin: route.origin, bearerToken: route.bearerToken,
            keyring: options.keyring, fetchImpl: options.fetchImpl ?? fetch,
            now: options.now ?? (() => new Date()),
          }),
        }),
      };
    } catch (error: unknown) {
      console.warn("[collaboration-cutover] home transport unavailable", error instanceof Error ? error.name : "UnknownError");
      return { status: "offline" as const };
    }
  };
}
