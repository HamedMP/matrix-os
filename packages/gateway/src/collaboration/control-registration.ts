import { COLLABORATION_DIRECT_LIMITS, COLLABORATION_DIRECT_PROTOCOL_VERSION, toLogicalRuntimeId } from "@matrix-os/contracts";
import { z } from "zod/v4";

const MIN_RETRY_AFTER_MS = 1_000;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

const RegistrationResponseSchema = z.object({
  protocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  runtime: z.object({ runtimeId: z.string(), authorityGeneration: z.number().int().positive(), registeredAt: z.string() }).strict(),
  platformSigningKeys: z.array(z.object({ keyId: z.string().min(1).max(80), algorithm: z.literal("ed25519"), publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()).max(8),
  controlTicket: z.string().min(43).max(256).regex(/^[A-Za-z0-9_-]+$/),
  relay: z.object({ origin: z.string().url() }).strict(),
}).strict();

export type RegistrationResponse = z.infer<typeof RegistrationResponseSchema>;

/** Registration refused by the platform with a non-success status; carries only coarse retry hints. */
export class RegistrationRejectedError extends Error {
  override readonly name = "RegistrationRejectedError";
  constructor(readonly status: number, readonly retryAfterMs?: number) {
    super(`Registration rejected (${status})`);
  }
}

/**
 * Parses a Retry-After header in its delta-seconds form, clamped to a sane range. The
 * HTTP-date form and anything malformed are ignored rather than trusted.
 */
export function parseRetryAfterMs(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,10}$/.test(trimmed)) return undefined;
  const ms = Number(trimmed) * 1_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, ms));
}

const ConflictSchema = z.object({
  error: z.literal("Collaboration state changed"),
  protocolVersion: z.literal(COLLABORATION_DIRECT_PROTOCOL_VERSION),
  runtime: z.object({ runtimeId: z.string().min(1).max(128), authorityGeneration: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict(),
}).strict();

/** Read only a small protocol response; neither conflict nor success may buffer arbitrary data. */
async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Registration response is invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Registration response is too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/**
 * A restarted home may have missed a generation advance. Only an authenticated,
 * exact-runtime 409 carrying a strictly higher generation permits one negotiation.
 * The conflict is not registration: it installs no keys, ticket or fresh snapshot.
 */
export async function registerControlRuntime(options: {
  endpoint: string; runtimeId: string; ownerId: string; relayHandle: string;
  identity: { keyId: string; publicKey: string }; headers: Record<string, string>;
  generation: number; closed(): boolean; fetchImpl: typeof fetch;
}): Promise<RegistrationResponse> {
  const runtimeId = toLogicalRuntimeId(options.runtimeId);
  let generation = options.generation;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.closed()) throw new Error("Control client is shutting down");
    const response = await options.fetchImpl(options.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...options.headers },
      body: JSON.stringify({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, runtimeId,
        ownerId: options.ownerId, relayHandle: options.relayHandle, authorityGeneration: generation,
        publicKeys: [{ keyId: options.identity.keyId, algorithm: "ed25519", publicKey: options.identity.publicKey }] }),
      redirect: "error", signal: AbortSignal.timeout(COLLABORATION_DIRECT_LIMITS.externalApiTimeoutMs),
    });
    if (response.status === 426) throw new Error("upgrade_required");
    if (response.status === 409 && attempt === 0) {
      const conflict = ConflictSchema.safeParse(await readResponse(response));
      if (conflict.success && conflict.data.runtime.runtimeId === runtimeId && conflict.data.runtime.authorityGeneration > generation) {
        generation = conflict.data.runtime.authorityGeneration;
        continue;
      }
    }
    if (!response.ok) {
      const throttled = response.status === 429 || response.status === 503;
      throw new RegistrationRejectedError(response.status, throttled ? parseRetryAfterMs(response.headers.get("retry-after")) : undefined);
    }
    const parsed = RegistrationResponseSchema.safeParse(await readResponse(response));
    if (!parsed.success || parsed.data.runtime.runtimeId !== runtimeId || (attempt === 1 && parsed.data.runtime.authorityGeneration < generation)) {
      throw new Error("Registration response is invalid");
    }
    return parsed.data;
  }
  throw new RegistrationRejectedError(409);
}
