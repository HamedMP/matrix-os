import {
  CollaborationActorIdSchema,
  CollaborationChatMessagesResponseSchema,
  CollaborationAiRequestAcceptedResponseSchema,
  CollaborationAiRequestsResponseSchema,
  CollaborationCreateAiRequestSchema,
  CollaborationCreateInvitationRequestSchema,
  CollaborationAiRequestControlSchema,
  CollaborationApprovalDecisionRequestSchema,
  CollaborationChatSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationDeclineInvitationRequestSchema,
  CollaborationDiscoveryItemSchema,
  CollaborationDiscussionMessageSchema,
  CollaborationDiscussionMessagesResponseSchema,
  CollaborationDiscussionUserStatePatchSchema,
  CollaborationDiscussionUserStateSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationHumanMessageSchema,
  CollaborationIdSchema,
  CollaborationInvitationSchema,
  CollaborationMemberPatchRequestSchema,
  CollaborationMemberSchema,
  CollaborationPageRequestSchema,
  CollaborationProjectSchema,
  CollaborationRevisionSchema,
  CollaborationResourceIdSchema,
  CollaborationScopeSchema,
  CollaborationTerminalActionResultSchema,
  CollaborationTerminalActionSchema,
  CollaborationTerminalSchema,
  CollaborationUserStateSchema,
  type CollaborationTerminalAction,
} from "@matrix-os/contracts/collaboration";
import { getRandomBytes } from "expo-crypto";
import { z } from "zod/v4";
import {
  CollaborationDirectError,
  createMobileCollaborationDirect,
  type CollaborationDeleteConditions,
  type CollaborationDirectMethod,
  type CollaborationDirectStream,
  type CollaborationStreamPurpose,
} from "@/lib/collaboration-direct";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { fetchAuthenticatedJson } from "./http";

const ERROR = "Collaboration unavailable. Try again.";
const AcceptedSchema = z.looseObject({
  scopeId: CollaborationIdSchema,
  actorId: z.string().min(1).max(128),
  status: z.literal("accepted"),
  revision: CollaborationRevisionSchema,
});
const AiControlResponseSchema = z.looseObject({
  state: z.enum(["accepted", "completed", "failed", "reconciling"]),
});
const DeclinedSchema = z.looseObject({
  scopeId: CollaborationIdSchema,
  actorId: z.string().min(1).max(128),
  status: z.literal("revoked"),
  scopeRevision: z.number().int().nonnegative(),
  memberRevision: z.number().int().nonnegative(),
});
const MembersSchema = z.strictObject({ members: z.array(CollaborationMemberSchema).max(8) });
const MemberMutationSchema = z.looseObject({
  scopeId: CollaborationIdSchema,
  actorId: CollaborationActorIdSchema,
  role: z.enum(["owner", "editor", "viewer"]),
  status: z.enum(["pending", "accepted", "revoked", "expired"]),
  scopeRevision: z.number().int().nonnegative(),
  memberRevision: z.number().int().nonnegative(),
});

const MAX_HYDRATION_CONCURRENCY = 4;

type DiscoveryItem = z.infer<typeof CollaborationDiscoveryItemSchema>;
interface ResponseSchema<T> { parse(value: unknown): T }

/**
 * Scope content lives on the resource's home and is reached only over the direct
 * transport; the platform serves discovery metadata and connection tickets.
 */
const direct = createMobileCollaborationDirect({ platformUrl: HOSTED_GATEWAY_URL, randomBytes: getRandomBytes });

function url(path: string): string {
  return `${HOSTED_GATEWAY_URL}${path}`;
}

async function scoped<T>(
  token: string,
  scopeId: string,
  schema: ResponseSchema<T>,
  method: CollaborationDirectMethod,
  path: string,
  body?: unknown,
  conditions?: CollaborationDeleteConditions,
): Promise<T> {
  try {
    return schema.parse(await direct.request(token, scopeId, method, path, body, conditions));
  } catch (error: unknown) {
    if (!(error instanceof CollaborationDirectError) && !(error instanceof z.ZodError)) {
      console.warn("[mobile-collaboration] scoped request failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new Error(ERROR);
  }
}

/** Ends every cached home session in this process, e.g. before another account signs in. */
export function closeCollaborationSessions(): void {
  direct.close();
}

function discoveryUrl(path: "inbox" | "shared", cursor?: string): string {
  if (!cursor) return url(`/api/collaboration/${path}`);
  const page = CollaborationPageRequestSchema.parse({ cursor, limit: 50 });
  const query = new URLSearchParams({ limit: String(page.limit), cursor: page.cursor! });
  return url(`/api/collaboration/${path}?${query.toString()}`);
}

export function fetchCollaborationInbox(token: string, cursor?: string) {
  return fetchAuthenticatedJson({ url: discoveryUrl("inbox", cursor), token, schema: CollaborationDiscoveryResponseSchema, errorMessage: ERROR });
}

export function fetchSharedCollaborations(token: string, cursor?: string) {
  return fetchAuthenticatedJson({ url: discoveryUrl("shared", cursor), token, schema: CollaborationDiscoveryResponseSchema, errorMessage: ERROR });
}

/**
 * Fills each metadata-only discovery item from the resource's home, the way the
 * web direct client does. An unreachable home leaves the item as `offline`, a
 * refusal or an unexpected shape as `denied`; kinds Native Mobile cannot open
 * yet stay metadata-only.
 */
export async function hydrateCollaborationDiscovery(token: string, items: readonly DiscoveryItem[]): Promise<DiscoveryItem[]> {
  const results: DiscoveryItem[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(MAX_HYDRATION_CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- intentional: each worker drains the shared queue one item at a time so at most MAX_HYDRATION_CONCURRENCY home requests are in flight.
      results[index] = await hydrateDiscoveryItem(token, items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function hydrateDiscoveryItem(token: string, item: DiscoveryItem): Promise<DiscoveryItem> {
  if (item.status === "organization_pending" || item.resource !== undefined) return item;
  try {
    if (item.status === "invited") {
      const resource = await direct.request(token, item.scopeId, "GET", `/api/collaboration/invitations/${item.invitationId}`);
      return parseHydrated({ ...item, resource });
    }
    const content = item.kind === "chat" || item.kind === "terminal" || item.kind === "project" ? item.kind : null;
    if (!content) return item;
    const base = `/api/collaboration/scopes/${item.scopeId}`;
    const [scope, value] = await Promise.all([
      direct.request(token, item.scopeId, "GET", base),
      direct.request(token, item.scopeId, "GET", `${base}/${content}`),
    ]);
    return parseHydrated({ ...item, resource: { scope, [content]: value } });
  } catch (error: unknown) {
    const code = error instanceof CollaborationDirectError ? error.code : "unavailable";
    if (!(error instanceof CollaborationDirectError)) {
      console.warn("[mobile-collaboration] discovery hydration failed", error instanceof Error ? error.name : "UnknownError");
    }
    return { ...item, home: code === "host_offline" || code === "unavailable" ? "offline" : "denied" };
  }
}

function parseHydrated(candidate: unknown): DiscoveryItem {
  const parsed = CollaborationDiscoveryItemSchema.safeParse(candidate);
  if (!parsed.success) throw new CollaborationDirectError("invalid_response");
  return parsed.data;
}

export function fetchCollaborationInvitation(token: string, scopeId: string, invitationId: string) {
  const id = CollaborationIdSchema.parse(invitationId);
  return scoped(token, scopeId, CollaborationInvitationSchema, "GET", `/api/collaboration/invitations/${id}`);
}

export function acceptCollaborationInvitation(
  token: string,
  scopeId: string,
  invitationId: string,
  expectedRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(invitationId);
  return scoped(token, scopeId, AcceptedSchema, "POST", `/api/collaboration/invitations/${id}/accept`, {
    clientRequestId: CollaborationIdSchema.parse(clientRequestId),
    expectedRevision: CollaborationRevisionSchema.parse(expectedRevision),
  });
}

export function declineCollaborationInvitation(
  token: string,
  scopeId: string,
  invitationId: string,
  expectedRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(invitationId);
  const body = CollaborationDeclineInvitationRequestSchema.parse({ clientRequestId, expectedRevision });
  return scoped(token, scopeId, DeclinedSchema, "POST", `/api/collaboration/invitations/${id}/decline`, body);
}

export function fetchCollaborationScope(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationScopeSchema, "GET", `/api/collaboration/scopes/${id}`);
}

export function fetchCollaborationMembers(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, MembersSchema, "GET", `/api/collaboration/scopes/${id}/members`);
}

export function inviteCollaborationMember(
  token: string,
  scopeId: string,
  identifier: string,
  role: "editor" | "viewer",
  expectedRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const body = CollaborationCreateInvitationRequestSchema.parse({ identifier, role, expectedRevision, clientRequestId });
  return scoped(token, id, CollaborationInvitationSchema, "POST", `/api/collaboration/scopes/${id}/invitations`, body);
}

export function changeCollaborationMemberRole(
  token: string,
  scopeId: string,
  actorId: string,
  role: "editor" | "viewer",
  expectedRevision: string,
  expectedMemberRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const actor = CollaborationActorIdSchema.parse(actorId);
  const body = CollaborationMemberPatchRequestSchema.parse({
    role, expectedRevision, expectedMemberRevision, clientRequestId,
  });
  return scoped(token, id, MemberMutationSchema, "PATCH", `/api/collaboration/scopes/${id}/members/${encodeURIComponent(actor)}`, body);
}

export function removeCollaborationMember(
  token: string,
  scopeId: string,
  actorId: string,
  expectedRevision: string,
  expectedMemberRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const actor = CollaborationActorIdSchema.parse(actorId);
  return scoped(token, id, MemberMutationSchema, "DELETE", `/api/collaboration/scopes/${id}/members/${encodeURIComponent(actor)}`,
    undefined, { clientRequestId, expectedRevision, expectedMemberRevision });
}

export function revokeCollaborationInvitation(
  token: string,
  scopeId: string,
  invitationId: string,
  expectedRevision: string,
  expectedMemberRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const invitation = CollaborationIdSchema.parse(invitationId);
  return scoped(token, id, MemberMutationSchema, "DELETE", `/api/collaboration/scopes/${id}/invitations/${invitation}`,
    undefined, { clientRequestId, expectedRevision, expectedMemberRevision });
}

export function fetchSharedProject(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationProjectSchema, "GET", `/api/collaboration/scopes/${id}/project`);
}

export function fetchSharedChat(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationChatSchema, "GET", `/api/collaboration/scopes/${id}/chat`);
}

export function fetchSharedChatMessages(token: string, scopeId: string, after = "0") {
  const id = CollaborationIdSchema.parse(scopeId);
  const cursor = CollaborationRevisionSchema.parse(after);
  return scoped(token, id, CollaborationChatMessagesResponseSchema, "GET",
    `/api/collaboration/scopes/${id}/chat/messages?after=${cursor}&limit=100`);
}

export function postSharedChatDiscussion(
  token: string,
  scopeId: string,
  expectedRevision: string,
  text: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationHumanMessageSchema, "POST", `/api/collaboration/scopes/${id}/chat/messages`, {
    clientRequestId: CollaborationIdSchema.parse(clientRequestId),
    expectedRevision: CollaborationRevisionSchema.parse(expectedRevision),
    text: z.string().trim().min(1).max(65_536).parse(text),
  });
}

export function fetchSessionDiscussion(token: string, scopeId: string, after = "0") {
  const id = CollaborationIdSchema.parse(scopeId);
  const cursor = CollaborationRevisionSchema.parse(after);
  return scoped(token, id, CollaborationDiscussionMessagesResponseSchema, "GET",
    `/api/collaboration/scopes/${id}/discussion/messages?after=${cursor}&limit=100`);
}

export function postSessionDiscussion(
  token: string,
  scopeId: string,
  expectedRevision: string,
  text: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const body = CollaborationCreateDiscussionRequestSchema.parse({
    clientRequestId,
    expectedRevision,
    text,
  });
  return scoped(token, id, CollaborationDiscussionMessageSchema, "POST", `/api/collaboration/scopes/${id}/discussion/messages`, body);
}

export function fetchSessionDiscussionUserState(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationDiscussionUserStateSchema, "GET", `/api/collaboration/scopes/${id}/discussion/user-state`);
}

export function updateSessionDiscussionReadState(token: string, scopeId: string, readThroughSeq: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  const body = CollaborationDiscussionUserStatePatchSchema.parse({ readThroughSeq });
  return scoped(token, id, CollaborationDiscussionUserStateSchema, "PATCH", `/api/collaboration/scopes/${id}/discussion/user-state`, body);
}

export function fetchSharedAiRequests(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationAiRequestsResponseSchema, "GET", `/api/collaboration/scopes/${id}/chat/requests`);
}

export function postSharedAiRequest(
  token: string,
  scopeId: string,
  expectedRevision: string,
  text: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const body = CollaborationCreateAiRequestSchema.parse({
    clientRequestId,
    expectedRevision,
    text,
  });
  return scoped(token, id, CollaborationAiRequestAcceptedResponseSchema, "POST", `/api/collaboration/scopes/${id}/chat/requests`, body);
}

export function controlSharedAiRequest(
  token: string,
  scopeId: string,
  requestId: string,
  action: "cancel" | "retry",
  expectedRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const request = CollaborationResourceIdSchema.parse(requestId);
  const body = CollaborationAiRequestControlSchema.parse({ clientRequestId, expectedRevision });
  return scoped(token, id, AiControlResponseSchema, "POST", `/api/collaboration/scopes/${id}/chat/requests/${request}/${action}`, body);
}

export function decideSharedAiApproval(
  token: string,
  scopeId: string,
  approvalId: string,
  runId: string,
  decision: "approve" | "approve_for_session" | "decline" | "cancel",
  expectedRevision: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const approval = CollaborationResourceIdSchema.parse(approvalId);
  const body = CollaborationApprovalDecisionRequestSchema.parse({
    clientRequestId,
    expectedRevision,
    runId,
    decision,
  });
  return scoped(token, id, AiControlResponseSchema, "POST", `/api/collaboration/scopes/${id}/chat/approvals/${approval}/decision`, body);
}

export function updateSharedChatReadState(token: string, scopeId: string, readThroughSeq: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationUserStateSchema, "PATCH", `/api/collaboration/scopes/${id}/user-state`, {
    readThroughSeq: CollaborationRevisionSchema.parse(readThroughSeq),
  });
}

/**
 * A one-use direct event or terminal socket for this scope: open `url` with
 * `headers`, then send `handshake` as the first frame before anything else.
 */
export async function openCollaborationStream(
  token: string,
  scopeId: string,
  purpose: CollaborationStreamPurpose,
  after = "0",
): Promise<CollaborationDirectStream> {
  try {
    return await direct.stream(token, CollaborationIdSchema.parse(scopeId), purpose, after);
  } catch (error: unknown) {
    if (!(error instanceof CollaborationDirectError) && !(error instanceof z.ZodError)) {
      console.warn("[mobile-collaboration] stream preparation failed", error instanceof Error ? error.name : "UnknownError");
    }
    throw new Error(ERROR);
  }
}

export function fetchSharedTerminal(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return scoped(token, id, CollaborationTerminalSchema, "GET", `/api/collaboration/scopes/${id}/terminal`);
}

export function controlSharedTerminal(
  token: string,
  scopeId: string,
  action: CollaborationTerminalAction,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  const body = CollaborationTerminalActionSchema.parse(action);
  return scoped(token, id, CollaborationTerminalActionResultSchema, "POST", `/api/collaboration/scopes/${id}/terminal/actions`, body);
}
