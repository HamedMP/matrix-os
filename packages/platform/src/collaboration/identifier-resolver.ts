import {
  CollaborationActorIdSchema,
  CollaborationInvitationIdentifierSchema,
  CollaborationOrganizationIdSchema,
  CollaborationParticipantSchema,
} from "@matrix-os/contracts";
import { z } from "zod/v4";
import { HANDLE_PATTERN } from "../platform-route-utils.js";

const CLERK_LOOKUP_TIMEOUT_MS = 10_000;
const CLERK_LOOKUP_LIMIT = 20;
const MAX_CLERK_RESPONSE_BYTES = 64 * 1024;
const CLERK_ACTOR_ID_PATTERN = /^user_[A-Za-z0-9_-]{1,123}$/;

type Participant = z.infer<typeof CollaborationParticipantSchema>;

const ClerkUserSchema = z.object({
  id: CollaborationActorIdSchema,
  email_addresses: z.array(z.object({
    email_address: z.string().max(320),
    verification: z.object({ status: z.string().max(32) }).passthrough().nullable().optional(),
  }).passthrough()).max(100),
}).passthrough();
const ClerkUsersSchema = z.array(ClerkUserSchema).max(CLERK_LOOKUP_LIMIT);

export type NormalizedCollaborationIdentifier =
  | { kind: "actor_id"; value: string }
  | { kind: "email"; value: string }
  | { kind: "username"; value: string };

/**
 * Current-membership answer for one organization. S03 registers the Clerk
 * membership projection; until then no projection exists and the resolver
 * resolves nothing (S20 / T101).
 */
export interface CollaborationOrganizationMembershipProjection {
  isCurrentMember(input: { organizationId: string; actorId: string }): Promise<boolean>;
}

export class CollaborationIdentifierResolutionError extends Error {
  constructor(public readonly code: "unresolved" | "unavailable" = "unresolved") {
    super("Invitation target is unavailable");
    this.name = "CollaborationIdentifierResolutionError";
  }
}

export function normalizeCollaborationIdentifier(input: string): NormalizedCollaborationIdentifier {
  const parsed = CollaborationInvitationIdentifierSchema.safeParse(input);
  if (!parsed.success) throw new CollaborationIdentifierResolutionError();
  const identifier = parsed.data;
  if (identifier.startsWith("user_")) {
    if (!CLERK_ACTOR_ID_PATTERN.test(identifier)) throw new CollaborationIdentifierResolutionError();
    return { kind: "actor_id", value: identifier };
  }
  if (identifier.startsWith("@")) {
    const username = identifier.slice(1).toLowerCase();
    if (!HANDLE_PATTERN.test(username)) throw new CollaborationIdentifierResolutionError();
    return { kind: "username", value: username };
  }
  if (identifier.includes("@")) {
    const email = z.email().max(254).safeParse(identifier);
    if (!email.success) throw new CollaborationIdentifierResolutionError();
    return { kind: "email", value: email.data.toLowerCase() };
  }
  const username = identifier.toLowerCase();
  if (!HANDLE_PATTERN.test(username)) throw new CollaborationIdentifierResolutionError();
  return { kind: "username", value: username };
}

export class PlatformCollaborationIdentifierResolver {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: {
    clerkSecretKey?: string;
    getAccountByActorId(actorId: string): Promise<Participant | null>;
    listAccountsByUsername(username: string): Promise<Participant[]>;
    membershipProjection?: CollaborationOrganizationMembershipProjection;
    fetchImpl?: typeof fetch;
  }) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Resolves an identifier to a participant only when that participant is a
   * current member of `organizationId`. Any account outside the organization,
   * and every identifier while no membership projection is registered, yields
   * the same safe failure as an unknown identifier.
   */
  async resolve(input: string, organizationIdInput: string): Promise<Participant> {
    const organizationId = CollaborationOrganizationIdSchema.safeParse(organizationIdInput);
    if (!organizationId.success) throw new CollaborationIdentifierResolutionError();
    if (!this.options.membershipProjection) {
      console.warn("[platform-collaboration] invitation identifier refused: no membership projection registered");
      throw new CollaborationIdentifierResolutionError("unavailable");
    }
    const identifier = normalizeCollaborationIdentifier(input);
    const participant = identifier.kind === "actor_id"
      ? this.requireSingle(await this.options.getAccountByActorId(identifier.value))
      : identifier.kind === "username"
        ? this.requireUnique(await this.options.listAccountsByUsername(identifier.value))
        : await this.resolveEmail(identifier.value);
    let member: boolean;
    try {
      member = await this.options.membershipProjection.isCurrentMember({
        organizationId: organizationId.data,
        actorId: participant.actorId,
      });
    } catch (error: unknown) {
      console.warn("[platform-collaboration] membership projection lookup failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationIdentifierResolutionError("unavailable");
    }
    if (!member) throw new CollaborationIdentifierResolutionError();
    return participant;
  }

  private async resolveEmail(email: string): Promise<Participant> {
    if (!this.options.clerkSecretKey) throw new CollaborationIdentifierResolutionError("unavailable");
    const url = new URL("https://api.clerk.com/v1/users");
    url.searchParams.set("email_address", email);
    url.searchParams.set("limit", String(CLERK_LOOKUP_LIMIT));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.options.clerkSecretKey}`,
          accept: "application/json",
        },
        signal: AbortSignal.timeout(CLERK_LOOKUP_TIMEOUT_MS),
        redirect: "error",
      });
    } catch (error: unknown) {
      console.warn("[platform-collaboration] identity provider lookup failed", error instanceof Error ? error.name : "UnknownError");
      throw new CollaborationIdentifierResolutionError("unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      console.warn("[platform-collaboration] identity provider lookup failed", `Http${response.status}`);
      throw new CollaborationIdentifierResolutionError("unavailable");
    }
    const bytes = await readBounded(response, MAX_CLERK_RESPONSE_BYTES);
    if (!bytes) throw new CollaborationIdentifierResolutionError("unavailable");
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch (error: unknown) {
      if (!(error instanceof SyntaxError)) {
        console.warn("[platform-collaboration] identity provider response failed", error instanceof Error ? error.name : "UnknownError");
      }
      throw new CollaborationIdentifierResolutionError("unavailable");
    }
    const parsed = ClerkUsersSchema.safeParse(payload);
    if (!parsed.success || parsed.data.length >= CLERK_LOOKUP_LIMIT) {
      throw new CollaborationIdentifierResolutionError(parsed.success ? "unresolved" : "unavailable");
    }
    const exactMatches = parsed.data.filter((user) => user.email_addresses.some((candidate) =>
      candidate.verification?.status === "verified" && candidate.email_address.toLowerCase() === email,
    ));
    if (exactMatches.length !== 1) throw new CollaborationIdentifierResolutionError();
    return this.requireSingle(await this.options.getAccountByActorId(exactMatches[0]!.id));
  }

  private requireSingle(participant: Participant | null): Participant {
    if (!participant) throw new CollaborationIdentifierResolutionError();
    const parsed = CollaborationParticipantSchema.safeParse(participant);
    if (!parsed.success) throw new CollaborationIdentifierResolutionError("unavailable");
    return parsed.data;
  }

  private requireUnique(participants: Participant[]): Participant {
    if (participants.length !== 1) throw new CollaborationIdentifierResolutionError();
    return this.requireSingle(participants[0] ?? null);
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
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
