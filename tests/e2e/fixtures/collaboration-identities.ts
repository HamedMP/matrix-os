import { z } from "zod/v4";

const ClerkId = z.string().min(4).max(128).regex(/^[A-Za-z0-9_-]+$/);
const MAX_CLERK_RESPONSE_BYTES = 64 * 1024;
const CLERK_TIMEOUT_MS = 10_000;
const ROLE_NAMES = ["owner", "member", "outsider", "guest"] as const;

export type CollaborationRole = typeof ROLE_NAMES[number];

const EnvironmentSchema = z.object({
  CLERK_SECRET_KEY: z.string().min(1),
  COLLABORATION_E2E_ALLOWED_USER_IDS: z.string().min(1),
  COLLABORATION_E2E_ORGANIZATION_ID: ClerkId,
  COLLABORATION_E2E_OWNER_USER_ID: ClerkId,
  COLLABORATION_E2E_MEMBER_USER_ID: ClerkId,
  COLLABORATION_E2E_OUTSIDER_USER_ID: ClerkId,
  COLLABORATION_E2E_GUEST_USER_ID: ClerkId,
  COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID: ClerkId.optional(),
  PREVIEW_COLLABORATION_OWNER_USER_ID: ClerkId,
  PREVIEW_CLERK_USER_ID: ClerkId.optional(),
  MATRIX_COLLABORATION_E2E_BASE_URL: z.url(),
  COLLABORATION_E2E_PREVIEW_PR_NUMBER: z.string().regex(/^[1-9][0-9]{0,7}$/),
});

const ClerkUserSchema = z.object({
  id: ClerkId,
  primary_email_address_id: ClerkId,
  public_metadata: z.object({ matrixE2e: z.literal(true) }).passthrough(),
  email_addresses: z.array(z.object({
    id: ClerkId,
    email_address: z.email().max(254),
    verification: z.object({ status: z.string() }).passthrough(),
  }).passthrough()).max(100),
}).passthrough();

export interface CollaborationIdentityEnvironment {
  baseUrl: string;
  previewHandle: string;
  organizationId: string;
  clerkSecretKey: string;
  allowedUserIds: ReadonlySet<string>;
  roleUserIds: Record<CollaborationRole, string>;
  multiComputerMemberUserId?: string;
}

export interface VerifiedFixtureUser { id: string; emailAddress: string }

export interface CollaborationActorPreconditions {
  computers: ReadonlyArray<{ handle: string }>;
  phase: string;
  organizations: ReadonlyArray<{ organizationId: string; role: string }>;
  inboxCount: number;
  sharedCount: number;
}

export function assertCollaborationPreconditions(
  config: CollaborationIdentityEnvironment,
  actors: Record<CollaborationRole, CollaborationActorPreconditions>,
): void {
  if (!actors.owner.computers.some((computer) => computer.handle === config.previewHandle)) {
    throw new Error("Collaboration owner cannot access the exact preview computer");
  }
  for (const [role, expectedRole] of [["owner", "org:admin"], ["member", "org:member"]] as const) {
    const matches = actors[role].organizations.filter((entry) => entry.organizationId === config.organizationId);
    if (matches.length !== 1 || matches[0]?.role !== expectedRole) {
      throw new Error("Collaboration fixture organization roles are incorrect");
    }
  }
  for (const role of ["member", "outsider", "guest"] as const) {
    const actor = actors[role];
    if (actor.computers.length !== 0 || actor.phase !== "plan_required") {
      throw new Error("Machine-free collaboration identity has runtime access");
    }
  }
  for (const role of ["outsider", "guest"] as const) {
    const actor = actors[role];
    if (actor.organizations.some((entry) => entry.organizationId === config.organizationId)
      || actor.inboxCount !== 0 || actor.sharedCount !== 0) {
      throw new Error("Denied collaboration identity already has access");
    }
  }
}

export function assertMultiComputerMemberPreconditions(
  config: CollaborationIdentityEnvironment,
  actor: CollaborationActorPreconditions,
): void {
  const membership = actor.organizations.filter((entry) => entry.organizationId === config.organizationId);
  if (actor.computers.length < 2 || membership.length !== 1 || membership[0]?.role !== "org:member") {
    throw new Error("Optional collaboration identity needs multiple computers and member authority");
  }
}

/** Parse all identities before any Clerk API call or sign-in token request. */
export function parseCollaborationIdentityEnvironment(
  environment: Record<string, string | undefined> = process.env,
): CollaborationIdentityEnvironment {
  const parsed = EnvironmentSchema.safeParse(environment);
  if (!parsed.success) throw new Error("Collaboration identity fixture configuration is incomplete");
  const values = parsed.data;
  const rawIds = values.COLLABORATION_E2E_ALLOWED_USER_IDS.split(",").map((id) => id.trim());
  if (rawIds.length < 4 || rawIds.length > 5 || rawIds.some((id) => !ClerkId.safeParse(id).success)) {
    throw new Error("Collaboration identity allowlist is invalid");
  }
  const allowedUserIds = new Set(rawIds);
  if (allowedUserIds.size !== rawIds.length) throw new Error("Collaboration identity allowlist has duplicates");
  const roleUserIds = {
    owner: values.COLLABORATION_E2E_OWNER_USER_ID,
    member: values.COLLABORATION_E2E_MEMBER_USER_ID,
    outsider: values.COLLABORATION_E2E_OUTSIDER_USER_ID,
    guest: values.COLLABORATION_E2E_GUEST_USER_ID,
  };
  const requiredIds = [...Object.values(roleUserIds), ...(values.COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID ? [values.COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID] : [])];
  if (new Set(requiredIds).size !== requiredIds.length || requiredIds.length !== allowedUserIds.size
    || requiredIds.some((id) => !allowedUserIds.has(id))) {
    throw new Error("Collaboration identities do not match the allowlist");
  }
  if (values.PREVIEW_COLLABORATION_OWNER_USER_ID !== roleUserIds.owner
    || (values.PREVIEW_CLERK_USER_ID && allowedUserIds.has(values.PREVIEW_CLERK_USER_ID))) {
    throw new Error("Collaboration preview owner is not isolated from the repository preview owner");
  }
  const origin = new URL(values.MATRIX_COLLABORATION_E2E_BASE_URL);
  if (origin.toString() !== `${origin.origin}/` || !["https://app.matrix-os.com", "https://preview.matrix-os.com"].includes(origin.origin)) {
    throw new Error("Collaboration identity fixture requires an approved platform origin");
  }
  return {
    baseUrl: origin.origin,
    previewHandle: `pr-${values.COLLABORATION_E2E_PREVIEW_PR_NUMBER}`,
    organizationId: values.COLLABORATION_E2E_ORGANIZATION_ID,
    clerkSecretKey: values.CLERK_SECRET_KEY,
    allowedUserIds,
    roleUserIds,
    ...(values.COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID ? { multiComputerMemberUserId: values.COLLABORATION_E2E_MULTI_COMPUTER_MEMBER_USER_ID } : {}),
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_CLERK_RESPONSE_BYTES) throw new Error("Clerk fixture user response is too large");
  if (!response.body) throw new Error("Clerk fixture user response is empty");
  const chunks: Uint8Array[] = [];
  const reader = response.body.getReader();
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CLERK_RESPONSE_BYTES) throw new Error("Clerk fixture user response is too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch((error: unknown) => {
      console.warn("[collaboration fixture] Clerk response cleanup failed", error instanceof Error ? error.name : "UnknownError");
    });
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

/** Guarded lookup. This must run before any helper that can mint a sign-in token. */
export async function verifyClerkFixtureUser(
  config: CollaborationIdentityEnvironment,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifiedFixtureUser> {
  if (!config.allowedUserIds.has(userId) || !ClerkId.safeParse(userId).success) {
    throw new Error("User is not a collaboration test identity");
  }
  const response = await fetchImpl(`https://api.clerk.com/v1/users/${encodeURIComponent(userId)}`, {
    headers: { Authorization: `Bearer ${config.clerkSecretKey}`, Accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(CLERK_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error("Collaboration test identity could not be verified");
  let body: unknown;
  try {
    body = await boundedJson(response);
  } catch (error: unknown) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error)) console.warn("[collaboration fixture] Clerk lookup failed", "UnknownError");
    throw new Error("Collaboration test identity could not be verified");
  }
  const parsed = ClerkUserSchema.safeParse(body);
  if (!parsed.success || parsed.data.id !== userId) throw new Error("User is not a verified collaboration test identity");
  const primary = parsed.data.email_addresses.find((address) => address.id === parsed.data.primary_email_address_id);
  if (!primary || primary.verification.status !== "verified") throw new Error("Collaboration test identity has no verified primary address");
  return { id: parsed.data.id, emailAddress: primary.email_address };
}

export async function loadCollaborationIdentities(
  environment: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ config: CollaborationIdentityEnvironment; users: Record<CollaborationRole, VerifiedFixtureUser>; multiComputerMember?: VerifiedFixtureUser }> {
  const config = parseCollaborationIdentityEnvironment(environment);
  const users = {} as Record<CollaborationRole, VerifiedFixtureUser>;
  for (const role of ROLE_NAMES) users[role] = await verifyClerkFixtureUser(config, config.roleUserIds[role], fetchImpl);
  const multiComputerMember = config.multiComputerMemberUserId
    ? await verifyClerkFixtureUser(config, config.multiComputerMemberUserId, fetchImpl) : undefined;
  return { config, users, ...(multiComputerMember ? { multiComputerMember } : {}) };
}
