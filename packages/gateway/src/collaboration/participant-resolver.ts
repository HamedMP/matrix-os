import {
  CollaborationActorIdSchema,
  CollaborationParticipantSchema,
  CollaborationRuntimeIdSchema,
} from "@matrix-os/contracts";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024;
const MAX_CACHE_ENTRIES = 512;
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  participant: { actorId: string; displayName: string };
  expiresAt: number;
}

export class CollaborationParticipantResolverError extends Error {
  constructor() {
    super("Participant identity is unavailable");
    this.name = "CollaborationParticipantResolverError";
  }
}

export class CollaborationParticipantResolver {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: {
    platformBaseUrl: string;
    runtimeId: string;
    serviceToken: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
  }) {
    const baseUrl = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl);
    CollaborationRuntimeIdSchema.parse(options.runtimeId);
    if (Buffer.byteLength(options.serviceToken) < 32) {
      throw new Error("Collaboration participant service token is unavailable");
    }
    this.endpoint = `${baseUrl.origin}/internal/collaboration/participants`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async resolve(actorIdInput: string): Promise<{ actorId: string; displayName: string }> {
    const actorId = CollaborationActorIdSchema.parse(actorIdInput);
    const now = this.now().getTime();
    const cached = this.cache.get(actorId);
    if (cached && cached.expiresAt > now) {
      this.cache.delete(actorId);
      this.cache.set(actorId, cached);
      return cached.participant;
    }
    if (cached) this.cache.delete(actorId);

    try {
      const response = await this.fetchImpl(`${this.endpoint}/${encodeURIComponent(actorId)}`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.options.serviceToken}`,
          "x-matrix-runtime-id": this.options.runtimeId,
        },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new CollaborationParticipantResolverError();
      }
      const bytes = await readBounded(response, MAX_RESPONSE_BYTES);
      if (!bytes) throw new CollaborationParticipantResolverError();
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      } catch (error: unknown) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new CollaborationParticipantResolverError();
      }
      const participant = CollaborationParticipantSchema.safeParse(value);
      if (!participant.success || participant.data.actorId !== actorId) {
        throw new CollaborationParticipantResolverError();
      }
      while (this.cache.size >= MAX_CACHE_ENTRIES) {
        const oldest = this.cache.keys().next().value as string | undefined;
        if (!oldest) break;
        this.cache.delete(oldest);
      }
      const result = { actorId: participant.data.actorId, displayName: participant.data.displayName };
      this.cache.set(actorId, { participant: result, expiresAt: now + CACHE_TTL_MS });
      return result;
    } catch (error: unknown) {
      console.warn("[collaboration-participant] identity lookup failed", error instanceof Error ? error.name : "UnknownError");
      if (error instanceof CollaborationParticipantResolverError) throw error;
      throw new CollaborationParticipantResolverError();
    }
  }

  shutdown(): void {
    this.cache.clear();
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  } finally {
    reader.releaseLock();
  }
}
