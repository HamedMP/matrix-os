/**
 * Gateway-side membership source for the S20 organization precondition
 * (S03 seam). It pulls fixed-deadline membership assertions from the
 * platform's `/internal/organizations/access/resolve` route with the
 * runtime's service credentials, caches each assertion only until the expiry
 * the platform issued (never renewed locally), coalesces concurrent lookups,
 * bounds the cache, and fails closed on any transport, status or schema error.
 */
import {
  COLLABORATION_DIRECT_PROTOCOL_VERSION,
  CollaborationActorIdSchema,
  CollaborationControlAssertionSchema,
  CollaborationOrganizationIdSchema,
  CollaborationRuntimeIdSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { OrganizationMembershipAssertion, OrganizationMembershipSource } from "./organization-precondition.js";
import { requireSecureCollaborationPlatformBaseUrl } from "./platform-base-url.js";

const CONTROL_LOOKUP_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_MAX_CACHE_ENTRIES = 1_000;
const AssertionsSchema = z.array(CollaborationControlAssertionSchema).max(100);

export class OrganizationMembershipClientError extends Error {
  constructor(message = "Organization membership is unavailable") {
    super(message);
    this.name = "OrganizationMembershipClientError";
  }
}

export class OrganizationMembershipClient implements OrganizationMembershipSource {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly maxEntries: number;
  private readonly cache = new Map<string, { member: boolean; expiresAt: string }>();
  private readonly inflight = new Map<string, Promise<OrganizationMembershipAssertion>>();

  constructor(private readonly options: {
    platformBaseUrl: string;
    runtimeId: string;
    serviceToken: string;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    maxCacheEntries?: number;
  }) {
    const baseUrl = requireSecureCollaborationPlatformBaseUrl(options.platformBaseUrl);
    CollaborationRuntimeIdSchema.parse(options.runtimeId);
    if (Buffer.byteLength(options.serviceToken) < 32) throw new Error("Collaboration service token is unavailable");
    this.endpoint = `${baseUrl.origin}/internal/organizations/access/resolve`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.maxEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  async assertMembership(input: { organizationId: string; actorId: string }): Promise<OrganizationMembershipAssertion> {
    const organizationId = CollaborationOrganizationIdSchema.parse(input.organizationId);
    const actorId = CollaborationActorIdSchema.parse(input.actorId);
    const key = `${organizationId}\u0000${actorId}`;
    const cached = this.cache.get(key);
    if (cached && Date.parse(cached.expiresAt) > this.now().getTime()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached.member ? { member: true, expiresAt: cached.expiresAt } : { member: false };
    }
    if (cached) this.cache.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const promise = this.lookup(organizationId, actorId, key).finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, promise);
    return promise;
  }

  describe(): { cacheEntries: number; inflight: number } {
    return { cacheEntries: this.cache.size, inflight: this.inflight.size };
  }

  private async lookup(organizationId: string, actorId: string, key: string): Promise<OrganizationMembershipAssertion> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(CONTROL_LOOKUP_TIMEOUT_MS),
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.options.serviceToken}`,
          "x-matrix-runtime-id": this.options.runtimeId,
        },
        body: JSON.stringify({ protocolVersion: COLLABORATION_DIRECT_PROTOCOL_VERSION, actors: [{ organizationId, actorId }] }),
      });
    } catch (error: unknown) {
      console.warn("[collaboration] membership lookup transport failed", error instanceof Error ? error.name : "UnknownError");
      throw new OrganizationMembershipClientError();
    }
    if (!response.ok) {
      await response.body?.cancel();
      console.warn("[collaboration] membership lookup rejected", `Http${response.status}`);
      throw new OrganizationMembershipClientError();
    }
    let parsed: z.infer<typeof AssertionsSchema>;
    try {
      const text = await readBounded(response, MAX_RESPONSE_BYTES);
      parsed = AssertionsSchema.parse(JSON.parse(text));
    } catch (error: unknown) {
      console.warn("[collaboration] membership lookup response invalid", error instanceof Error ? error.name : "UnknownError");
      throw new OrganizationMembershipClientError();
    }
    const assertion = parsed.find((frame) => frame.type === "membership_assertion" && frame.organizationId === organizationId && frame.actorId === actorId);
    if (!assertion || assertion.type !== "membership_assertion") throw new OrganizationMembershipClientError();
    this.cache.set(key, { member: assertion.member, expiresAt: assertion.expiresAt });
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return assertion.member ? { member: true, expiresAt: assertion.expiresAt } : { member: false };
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new OrganizationMembershipClientError();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new OrganizationMembershipClientError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
