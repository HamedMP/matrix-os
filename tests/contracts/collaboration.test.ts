import {
  CollaborationActorProofSchema,
  CollaborationCapabilityModeSchema,
  CollaborationConnectionTicketRequestSchema,
  CollaborationDiscoveryResponseSchema,
  CollaborationCreateDiscussionRequestSchema,
  CollaborationCreateInvitationRequestSchema,
  CollaborationCreateScopeRequestSchema,
  CollaborationEventFrameSchema,
  CollaborationInvitationSchema,
  CollaborationSharedChatMessageSchema,
  CollaborationMemberPatchRequestSchema,
  CollaborationPolicySchema,
  CollaborationRoleSchema,
  CollaborationScopeSchema,
  CollaborationScopePreflightRequestSchema,
  CollaborationUserStatePatchSchema,
} from "@matrix-os/contracts";
import { describe, expect, it } from "vitest";

const scopeId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const invitationId = "30000000-0000-4000-8000-000000000001";
const now = "2026-09-07T12:00:00.000Z";

describe("collaboration contracts", () => {
  it("keeps the role set and capability modes closed", () => {
    expect(CollaborationRoleSchema.options).toEqual(["owner", "editor", "viewer"]);
    expect(CollaborationCapabilityModeSchema.options).toEqual([
      "off",
      "internal",
      "enabled",
      "read_only",
    ]);
    expect(CollaborationRoleSchema.safeParse("commenter").success).toBe(false);
  });

  it("accepts a bounded live Chat scope without client-controlled authority", () => {
    expect(CollaborationScopeSchema.parse({
      id: scopeId,
      ownerId: "user_owner",
      kind: "chat",
      resourceId: "chat_release",
      membershipMode: "direct",
      lifecycle: "shared",
      revision: "4",
      authEpoch: "3",
      authorityGeneration: "1",
      role: "editor",
      capabilities: {
        read: true,
        discuss: true,
        manageMembers: false,
        requestAi: false,
      },
    })).toMatchObject({ role: "editor", kind: "chat" });

    expect(CollaborationScopeSchema.safeParse({
      id: scopeId,
      ownerId: "user_owner",
      kind: "chat",
      resourceId: "chat_release",
      membershipMode: "direct",
      lifecycle: "shared",
      revision: "4",
      authEpoch: "3",
      authorityGeneration: "1",
      role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
      ownerToken: "secret",
    }).success).toBe(false);
  });

  it("accepts only editor or viewer invitations and rejects identity injection", () => {
    expect(CollaborationCreateInvitationRequestSchema.parse({
      targetActorId: "user_editor",
      role: "editor",
      clientRequestId: requestId,
      expectedRevision: "4",
    })).toMatchObject({ role: "editor" });
    expect(CollaborationCreateInvitationRequestSchema.safeParse({
      targetActorId: "user_editor",
      role: "owner",
      clientRequestId: requestId,
      expectedRevision: "4",
    }).success).toBe(false);
    expect(CollaborationCreateInvitationRequestSchema.safeParse({
      targetActorId: "user_editor",
      role: "viewer",
      clientRequestId: requestId,
      expectedRevision: "4",
      invitedBy: "user_attacker",
    }).success).toBe(false);
  });

  it("projects bounded invitations without content or bearer authority", () => {
    const invitation = CollaborationInvitationSchema.parse({
      id: invitationId,
      scopeId,
      owner: { actorId: "user_owner", displayName: "Nima" },
      target: { actorId: "user_editor", displayName: "Ada" },
      scopeKind: "chat",
      role: "editor",
      status: "pending",
      expiresAt: "2026-09-14T12:00:00.000Z",
      revision: "1",
    });
    expect(invitation.status).toBe("pending");
    expect(CollaborationInvitationSchema.safeParse({
      ...invitation,
      transcript: "private content",
    }).success).toBe(false);
  });

  it("requires conditional role changes and never accepts owner promotion", () => {
    expect(CollaborationMemberPatchRequestSchema.parse({
      role: "viewer",
      clientRequestId: requestId,
      expectedRevision: "9",
      expectedMemberRevision: "2",
    }).role).toBe("viewer");
    expect(CollaborationMemberPatchRequestSchema.safeParse({
      role: "owner",
      clientRequestId: requestId,
      expectedRevision: "9",
      expectedMemberRevision: "2",
    }).success).toBe(false);
  });

  it("keeps owner scope conversion bound to one selected resource and preflight", () => {
    expect(CollaborationScopePreflightRequestSchema.parse({
      kind: "chat",
      resourceId: "chat_release",
    })).toEqual({ kind: "chat", resourceId: "chat_release" });
    expect(CollaborationCreateScopeRequestSchema.parse({
      kind: "chat",
      resourceId: "chat_release",
      clientRequestId: requestId,
      expectedRevision: "4",
      confirmationToken: "a".repeat(64),
    })).toMatchObject({ kind: "chat", resourceId: "chat_release" });
    expect(CollaborationScopePreflightRequestSchema.safeParse({
      kind: "document",
      resourceId: "private-file",
    }).success).toBe(false);
  });

  it("keeps user state actor-local and rejects actor overrides", () => {
    expect(CollaborationUserStatePatchSchema.parse({
      pinned: true,
      muted: false,
      readThroughSeq: "12",
    })).toEqual({ pinned: true, muted: false, readThroughSeq: "12" });
    expect(CollaborationUserStatePatchSchema.safeParse({
      pinned: true,
      actorId: "user_other",
    }).success).toBe(false);
  });

  it("bounds UTF-8 discussion text and does not accept AI or actor fields", () => {
    expect(CollaborationCreateDiscussionRequestSchema.parse({
      clientRequestId: requestId,
      expectedRevision: "4",
      text: "Discuss this with the team",
    }).text).toBe("Discuss this with the team");
    expect(CollaborationCreateDiscussionRequestSchema.safeParse({
      clientRequestId: requestId,
      expectedRevision: "4",
      text: "x".repeat(65_537),
    }).success).toBe(false);
    expect(CollaborationCreateDiscussionRequestSchema.safeParse({
      clientRequestId: requestId,
      expectedRevision: "4",
      text: "run the agent",
      mode: "ai",
      actorId: "user_owner",
    }).success).toBe(false);
  });

  it("binds actor proofs to exact transport facts", () => {
    expect(CollaborationActorProofSchema.parse({
      version: 1,
      keyId: "collaboration-2026-09",
      actorId: "user_editor",
      ownerId: "user_owner",
      runtimeId: "rt_owner",
      scopeId,
      purpose: "http",
      method: "POST",
      path: `/api/collaboration/scopes/${scopeId}/chat/messages`,
      query: "",
      bodyDigest: "a".repeat(64),
      conditionalHeadersDigest: "c".repeat(64),
      nonce: "b".repeat(32),
      issuedAt: now,
      expiresAt: "2026-09-07T12:00:30.000Z",
    })).toMatchObject({ actorId: "user_editor", purpose: "http" });
    expect(CollaborationActorProofSchema.safeParse({
      version: 1,
      keyId: "collaboration-2026-09",
      actorId: "user_editor",
      ownerId: "user_owner",
      runtimeId: "rt_owner",
      scopeId,
      purpose: "http",
      method: "POST",
      path: "https://owner.internal/api/collaboration",
      query: "",
      bodyDigest: "a".repeat(64),
      conditionalHeadersDigest: "c".repeat(64),
      nonce: "b".repeat(32),
      issuedAt: now,
      expiresAt: "2026-09-07T12:00:30.000Z",
    }).success).toBe(false);
  });

  it("keeps scope events content-free and versioned", () => {
    expect(CollaborationEventFrameSchema.parse({
      version: 1,
      type: "changed",
      scopeId,
      resourceId: "chat_release",
      authorityGeneration: "1",
      eventId: "40000000-0000-4000-8000-000000000001",
      sequence: "8",
      resourceKind: "chat",
      revision: "6",
    }).type).toBe("changed");
    expect(CollaborationEventFrameSchema.safeParse({
      version: 1,
      type: "changed",
      scopeId,
      resourceId: "chat_release",
      authorityGeneration: "1",
      eventId: "40000000-0000-4000-8000-000000000001",
      sequence: "8",
      resourceKind: "chat",
      revision: "6",
      text: "secret transcript",
    }).success).toBe(false);
  });

  it("bounds rollout policy without exposing authority secrets", () => {
    expect(CollaborationPolicySchema.parse({
      milestone: "m1",
      revision: "2",
      mode: "internal",
      cohort: ["user_owner", "user_editor"],
      issuedAt: now,
      expiresAt: "2026-09-14T12:00:00.000Z",
    })).toMatchObject({ mode: "internal" });
    expect(CollaborationPolicySchema.safeParse({
      milestone: "m1",
      revision: "2",
      mode: "enabled",
      cohort: Array.from({ length: 1_001 }, (_, index) => `user_${index}`),
      issuedAt: now,
      expiresAt: "2026-09-14T12:00:00.000Z",
      signingSecret: "must-not-cross-the-boundary",
    }).success).toBe(false);
  });

  it("binds connection-ticket requests to one exact stream purpose", () => {
    expect(CollaborationConnectionTicketRequestSchema.parse({
      clientRequestId: requestId,
      purpose: "events",
    }).purpose).toBe("events");
    expect(CollaborationConnectionTicketRequestSchema.safeParse({
      clientRequestId: requestId,
      purpose: "owner-terminal",
    }).success).toBe(false);
  });

  it("validates hydrated discovery and safe attributed history projections", () => {
    const scope = CollaborationScopeSchema.parse({
      id: scopeId, ownerId: "user_owner", kind: "chat", resourceId: "chat_release",
      membershipMode: "direct", lifecycle: "shared", revision: "4", authEpoch: "3",
      authorityGeneration: "1", role: "editor",
      capabilities: { read: true, discuss: true, manageMembers: false, requestAi: false },
    });
    const chat = {
      id: "chat_release", scopeId, title: "Release planning", lifecycle: "active" as const,
      revision: "4", messageCount: "1",
    };
    expect(CollaborationDiscoveryResponseSchema.parse({ items: [{
      scopeId, runtimeId: "runtime_owner", ownerId: "user_owner", kind: "chat",
      authorityGeneration: 1, status: "accepted", resource: { scope, chat },
    }] }).items[0]?.resource).toEqual({ scope, chat });

    expect(CollaborationSharedChatMessageSchema.parse({
      id: "msg_one", chatId: "chat_release", sequence: "1", role: "user",
      state: "committed", purpose: "discussion",
      actor: { actorId: "user_editor", displayName: "Ada" },
      parts: [{ type: "text", text: "Ship it" }], createdAt: now,
    })).toMatchObject({ actor: { displayName: "Ada" }, purpose: "discussion" });
  });
});
