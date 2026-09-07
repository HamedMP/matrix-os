import {
  CollaborationChatMessagesResponseSchema,
  CollaborationChatSchema,
  CollaborationConnectionTicketResponseSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationHumanMessageSchema,
  CollaborationIdSchema,
  CollaborationInvitationSchema,
  CollaborationPageRequestSchema,
  CollaborationRevisionSchema,
  CollaborationScopeSchema,
  CollaborationUserStateSchema,
} from "@matrix-os/contracts/collaboration";
import { z } from "zod/v4";
import { HOSTED_GATEWAY_URL } from "@/lib/storage";
import { fetchAuthenticatedJson } from "./http";

const ERROR = "Collaboration unavailable. Try again.";
const AcceptedSchema = z.looseObject({
  scopeId: CollaborationIdSchema,
  actorId: z.string().min(1).max(128),
  status: z.literal("accepted"),
  revision: CollaborationRevisionSchema,
});

function url(path: string): string {
  return `${HOSTED_GATEWAY_URL}${path}`;
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

export function fetchCollaborationInvitation(token: string, invitationId: string) {
  const id = CollaborationIdSchema.parse(invitationId);
  return fetchAuthenticatedJson({ url: url(`/api/collaboration/invitations/${id}`), token, schema: CollaborationInvitationSchema, errorMessage: ERROR });
}

export function acceptCollaborationInvitation(token: string, invitationId: string, expectedRevision: string, clientRequestId: string) {
  const id = CollaborationIdSchema.parse(invitationId);
  return fetchAuthenticatedJson({
    url: url(`/api/collaboration/invitations/${id}/accept`), token, schema: AcceptedSchema, errorMessage: ERROR,
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientRequestId: CollaborationIdSchema.parse(clientRequestId), expectedRevision: CollaborationRevisionSchema.parse(expectedRevision) }),
  });
}

export function fetchCollaborationScope(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return fetchAuthenticatedJson({ url: url(`/api/collaboration/scopes/${id}`), token, schema: CollaborationScopeSchema, errorMessage: ERROR });
}

export function fetchSharedChat(token: string, scopeId: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return fetchAuthenticatedJson({ url: url(`/api/collaboration/scopes/${id}/chat`), token, schema: CollaborationChatSchema, errorMessage: ERROR });
}

export function fetchSharedChatMessages(token: string, scopeId: string, after = "0") {
  const id = CollaborationIdSchema.parse(scopeId);
  const cursor = CollaborationRevisionSchema.parse(after);
  return fetchAuthenticatedJson({
    url: url(`/api/collaboration/scopes/${id}/chat/messages?after=${cursor}&limit=100`), token,
    schema: CollaborationChatMessagesResponseSchema, errorMessage: ERROR,
  });
}

export function postSharedChatDiscussion(
  token: string,
  scopeId: string,
  expectedRevision: string,
  text: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  return fetchAuthenticatedJson({
    url: url(`/api/collaboration/scopes/${id}/chat/messages`), token, schema: CollaborationHumanMessageSchema, errorMessage: ERROR,
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId: CollaborationIdSchema.parse(clientRequestId),
      expectedRevision: CollaborationRevisionSchema.parse(expectedRevision),
      text: z.string().trim().min(1).max(65_536).parse(text),
    }),
  });
}

export function updateSharedChatReadState(token: string, scopeId: string, readThroughSeq: string) {
  const id = CollaborationIdSchema.parse(scopeId);
  return fetchAuthenticatedJson({
    url: url(`/api/collaboration/scopes/${id}/user-state`), token, schema: CollaborationUserStateSchema, errorMessage: ERROR,
    method: "PATCH", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ readThroughSeq: CollaborationRevisionSchema.parse(readThroughSeq) }),
  });
}

export function fetchCollaborationEventTicket(
  token: string,
  scopeId: string,
  clientRequestId: string,
) {
  const id = CollaborationIdSchema.parse(scopeId);
  return fetchAuthenticatedJson({
    url: url(`/api/collaboration/scopes/${id}/connection-tickets`),
    token,
    schema: CollaborationConnectionTicketResponseSchema,
    errorMessage: ERROR,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId: CollaborationIdSchema.parse(clientRequestId),
      purpose: "events",
    }),
  });
}

export function collaborationEventsUrl(scopeId: string, ticket: string, after = "0"): string {
  const id = CollaborationIdSchema.parse(scopeId);
  const cursor = CollaborationRevisionSchema.parse(after);
  const parsedTicket = CollaborationConnectionTicketResponseSchema.shape.ticket.parse(ticket);
  const target = new URL(`/ws/collaboration/scopes/${id}/events`, HOSTED_GATEWAY_URL);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  target.searchParams.set("ticket", parsedTicket);
  target.searchParams.set("after", cursor);
  return target.toString();
}
