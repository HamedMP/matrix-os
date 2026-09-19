import { randomUUID } from "node:crypto";
import { expect, collaborationTest as test } from "./fixtures/collaboration";

test("owner publishes one complete project, then viewer downgrade and revoke apply to the same account", async ({ collaborationJourney }) => {
  const config = collaborationJourney;
  const projectId = process.env.MATRIX_COLLABORATION_E2E_PROJECT_ID!;
  const editorActorId = config.editorActorId;
  const ownerRequest = config.owner.context.request;
  const editorRequest = config.editor.context.request;
  const runtimeInfo = await ownerRequest.get(`${config.runtimeUrl}/api/system/info`);
  expect(runtimeInfo.ok()).toBe(true);
  const machineId = (await runtimeInfo.json() as { runtime: { machineId: string } }).runtime.machineId;
  const runtimeId = `vps:${machineId}`;
  const platform = config.platformUrl;

  const preflightResponse = await ownerRequest.post(`${platform}/api/collaboration/runtimes/${runtimeId}/scopes/preflight`, {
    data: { kind: "project", resourceId: projectId },
  });
  expect(preflightResponse.ok()).toBe(true);
  const preflight = await preflightResponse.json() as { eligible: boolean; resourceRevision: string; confirmationToken: string };
  expect(preflight.eligible).toBe(true);
  const createdResponse = await ownerRequest.post(`${platform}/api/collaboration/runtimes/${runtimeId}/scopes`, {
    data: {
      kind: "project",
      resourceId: projectId,
      clientRequestId: randomUUID(),
      expectedRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken,
    },
  });
  expect(createdResponse.ok()).toBe(true);
  const created = await createdResponse.json() as { id: string; revision: string };

  const unknown = await ownerRequest.post(`${platform}/api/collaboration/scopes/${created.id}/invitations`, {
    data: { identifier: "missing-matrix-account", role: "editor", clientRequestId: randomUUID(), expectedRevision: created.revision },
  });
  expect(unknown.status()).toBe(503);
  expect(await unknown.json()).toEqual({ error: "Invitation could not be created", code: "unavailable" });
  const membersAfterUnknown = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/members`);
  expect(await membersAfterUnknown.json()).toMatchObject({ members: [{ actor: { actorId: expect.any(String) }, role: "owner" }] });

  const invite = async (identifier: string) => {
    const currentScope = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}`);
    const expectedRevision = (await currentScope.json() as { revision: string }).revision;
    const response = await ownerRequest.post(`${platform}/api/collaboration/scopes/${created.id}/invitations`, {
      data: { identifier, role: "editor", clientRequestId: randomUUID(), expectedRevision },
    });
    expect(response.ok()).toBe(true);
    const invitation = await response.json() as { id: string; target: { actorId: string } };
    expect(invitation.target.actorId).toBe(editorActorId);
    return invitation.id;
  };
  const accept = async (invitationId: string) => {
    await expect.poll(async () => {
      const inbox = await editorRequest.get(`${platform}/api/collaboration/inbox`);
      const body = await inbox.json() as { items: Array<{ invitationId?: string }> };
      return body.items.some((item) => item.invitationId === invitationId);
    }).toBe(true);
    const invitationDetail = await editorRequest.get(`${platform}/api/collaboration/invitations/${invitationId}`);
    expect(invitationDetail.ok()).toBe(true);
    const detail = await invitationDetail.json() as { revision: string };
    const accepted = await editorRequest.post(`${platform}/api/collaboration/invitations/${invitationId}/accept`, {
      data: { clientRequestId: randomUUID(), expectedRevision: detail.revision },
    });
    expect(accepted.ok()).toBe(true);
  };
  const revokeMember = async () => {
    const [scopeResponse, membersResponse] = await Promise.all([
      ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}`),
      ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/members`),
    ]);
    const scope = await scopeResponse.json() as { revision: string };
    const members = await membersResponse.json() as { members: Array<{ actor: { actorId: string }; revision: string }> };
    const editor = members.members.find((member) => member.actor.actorId === editorActorId)!;
    const revoked = await ownerRequest.delete(`${platform}/api/collaboration/scopes/${created.id}/members/${editorActorId}`, {
      headers: {
        "x-matrix-client-request-id": randomUUID(),
        "x-matrix-expected-revision": scope.revision,
        "x-matrix-expected-member-revision": editor.revision,
      },
    });
    expect(revoked.ok()).toBe(true);
  };

  const usernameInvitationId = await invite(config.editorUsername);
  await accept(usernameInvitationId);
  await revokeMember();

  const emailInvitationId = await invite(config.editorEmail);
  const pendingScopeResponse = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}`);
  const pendingMembersResponse = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/members`);
  const pendingScope = await pendingScopeResponse.json() as { revision: string };
  const pendingMembers = await pendingMembersResponse.json() as { members: Array<{ actor: { actorId: string }; revision: string }> };
  const pendingEditor = pendingMembers.members.find((member) => member.actor.actorId === editorActorId)!;
  const revokedInvitation = await ownerRequest.delete(`${platform}/api/collaboration/scopes/${created.id}/invitations/${emailInvitationId}`, {
    headers: {
      "x-matrix-client-request-id": randomUUID(),
      "x-matrix-expected-revision": pendingScope.revision,
      "x-matrix-expected-member-revision": pendingEditor.revision,
    },
  });
  expect(revokedInvitation.ok()).toBe(true);

  const invitationId = await invite(`@${config.editorUsername}`);
  const invitationDetail = await editorRequest.get(`${platform}/api/collaboration/invitations/${invitationId}`);
  expect(invitationDetail.ok()).toBe(true);
  const detail = await invitationDetail.json() as { revision: string };
  const accepted = await editorRequest.post(`${platform}/api/collaboration/invitations/${invitationId}/accept`, {
    data: { clientRequestId: randomUUID(), expectedRevision: detail.revision },
  });
  expect(accepted.ok()).toBe(true);

  const inventoryResponse = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/project/inventory`);
  expect(inventoryResponse.ok()).toBe(true);
  const inventory = await inventoryResponse.json() as {
    scopeRevision: string;
    projectRevision: string;
    inventoryHash: string;
    membershipHash: string;
    inventoryToken: string;
    ownedItems: unknown[];
    blockers: unknown[];
  };
  expect(inventory.ownedItems.length).toBeGreaterThan(0);
  expect(inventory.blockers).toEqual([]);
  const confirmed = await ownerRequest.post(`${platform}/api/collaboration/scopes/${created.id}/project/confirm`, {
    data: {
      clientRequestId: randomUUID(),
      expectedScopeRevision: inventory.scopeRevision,
      expectedProjectRevision: inventory.projectRevision,
      inventoryHash: inventory.inventoryHash,
      membershipHash: inventory.membershipHash,
      inventoryToken: inventory.inventoryToken,
    },
  });
  expect(confirmed.status()).toBe(202);

  await expect.poll(async () => {
    const response = await editorRequest.get(`${platform}/api/collaboration/scopes/${created.id}/project`);
    return response.ok() ? (await response.json() as { status: string }).status : "pending";
  }, { timeout: 60_000 }).toBe("active");

  const membersResponse = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/members`);
  const members = await membersResponse.json() as { members: Array<{ actor: { actorId: string }; revision: string }> };
  const editor = members.members.find((member) => member.actor.actorId === editorActorId)!;
  const scopeResponse = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}`);
  const scope = await scopeResponse.json() as { revision: string };
  const downgraded = await ownerRequest.patch(`${platform}/api/collaboration/scopes/${created.id}/members/${editorActorId}`, {
    data: { role: "viewer", clientRequestId: randomUUID(), expectedRevision: scope.revision, expectedMemberRevision: editor.revision },
  });
  expect(downgraded.ok()).toBe(true);
  const viewerScope = await editorRequest.get(`${platform}/api/collaboration/scopes/${created.id}`);
  expect(await viewerScope.json()).toMatchObject({ role: "viewer", capabilities: { manageMembers: false } });

  const latestScope = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}`);
  const latestMembers = await ownerRequest.get(`${platform}/api/collaboration/scopes/${created.id}/members`);
  const latest = await latestMembers.json() as { members: Array<{ actor: { actorId: string }; revision: string }> };
  const latestEditor = latest.members.find((member) => member.actor.actorId === editorActorId)!;
  const revoked = await ownerRequest.delete(`${platform}/api/collaboration/scopes/${created.id}/members/${editorActorId}`, {
    headers: {
      "x-matrix-client-request-id": randomUUID(),
      "x-matrix-expected-revision": (await latestScope.json() as { revision: string }).revision,
      "x-matrix-expected-member-revision": latestEditor.revision,
    },
  });
  expect(revoked.ok()).toBe(true);
  await expect.poll(async () => (await editorRequest.get(`${platform}/api/collaboration/scopes/${created.id}`)).status())
    .toBe(404);
});

test("two accounts complete an isolated Codex shared-Chat round trip", async ({ collaborationJourney }) => {
  const config = collaborationJourney;
  const owner = config.owner.context.request;
  const editor = config.editor.context.request;
  const runtimeInfo = await owner.get(`${config.runtimeUrl}/api/system/info`);
  expect(runtimeInfo.ok()).toBe(true);
  const machineId = (await runtimeInfo.json() as { runtime: { machineId: string } }).runtime.machineId;
  const runtimeId = `vps:${machineId}`;
  const platform = config.platformUrl;

  const createdResponse = await owner.post(`${config.runtimeUrl}/api/chats`, {
    data: { clientRequestId: `req_${randomUUID().replaceAll("-", "")}`, title: "Disposable Codex collaboration" },
  });
  expect(createdResponse.status()).toBe(201);
  const created = await createdResponse.json() as { chat: { id: string; revision: number } };
  const chatId = created.chat.id;
  const initial = await owner.post(`${config.runtimeUrl}/api/chats/${chatId}/turns`, {
    data: {
      clientRequestId: `req_${randomUUID().replaceAll("-", "")}`,
      baseRevision: created.chat.revision,
      parts: [{ type: "text", text: "Reply with exactly: disposable owner binding ready" }],
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
      interactionMode: "default",
      permissionMode: "supervised",
    },
  });
  expect(initial.status()).toBe(202);
  await expect.poll(async () => {
    const detail = await owner.get(`${config.runtimeUrl}/api/chats/${chatId}`);
    if (!detail.ok()) return "unavailable";
    const body = await detail.json() as {
      record: {
        providerBinding?: { driverKind: string; instanceId: string };
        activeRun?: unknown;
      };
    };
    return !body.record.activeRun
      && body.record.providerBinding?.driverKind === "codex"
      && body.record.providerBinding.instanceId === "codex_default"
      ? "ready"
      : "pending";
  }, { timeout: 120_000 }).toBe("ready");

  const preflightResponse = await owner.post(
    `${platform}/api/collaboration/runtimes/${runtimeId}/scopes/preflight`,
    { data: { kind: "chat", resourceId: chatId } },
  );
  expect(preflightResponse.ok()).toBe(true);
  const preflight = await preflightResponse.json() as {
    eligible: boolean;
    resourceRevision: string;
    confirmationToken: string;
  };
  expect(preflight.eligible).toBe(true);
  const sharedResponse = await owner.post(`${platform}/api/collaboration/runtimes/${runtimeId}/scopes`, {
    data: {
      kind: "chat",
      resourceId: chatId,
      clientRequestId: randomUUID(),
      expectedRevision: preflight.resourceRevision,
      confirmationToken: preflight.confirmationToken,
    },
  });
  expect(sharedResponse.ok()).toBe(true);
  const shared = await sharedResponse.json() as { id: string; revision: string };

  const inviteResponse = await owner.post(`${platform}/api/collaboration/scopes/${shared.id}/invitations`, {
    data: {
      identifier: `@${config.editorUsername}`,
      role: "editor",
      clientRequestId: randomUUID(),
      expectedRevision: shared.revision,
    },
  });
  expect(inviteResponse.status()).toBe(201);
  const invitation = await inviteResponse.json() as { id: string };
  const invitationDetail = await editor.get(`${platform}/api/collaboration/invitations/${invitation.id}`);
  expect(invitationDetail.ok()).toBe(true);
  const invitationRevision = (await invitationDetail.json() as { revision: string }).revision;
  const accepted = await editor.post(`${platform}/api/collaboration/invitations/${invitation.id}/accept`, {
    data: { clientRequestId: randomUUID(), expectedRevision: invitationRevision },
  });
  expect(accepted.ok()).toBe(true);

  const sharedChat = await editor.get(`${platform}/api/collaboration/scopes/${shared.id}/chat`);
  expect(sharedChat.ok()).toBe(true);
  const discussionRevision = (await sharedChat.json() as { revision: string }).revision;
  const discussion = await editor.post(`${platform}/api/collaboration/scopes/${shared.id}/chat/messages`, {
    data: {
      clientRequestId: randomUUID(),
      expectedRevision: discussionRevision,
      text: "This is disposable two-account discussion state.",
    },
  });
  expect(discussion.status()).toBe(201);

  const capabilityResponse = await editor.get(`${platform}/api/collaboration/scopes/${shared.id}/chat/requests`);
  expect(capabilityResponse.ok()).toBe(true);
  const capability = await capabilityResponse.json() as {
    capability: { status: string; effectiveSelection?: { instanceId: string; model: string } };
    resourceRevision: string;
  };
  expect(capability.capability).toEqual({
    status: "available",
    effectiveSelection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
  });
  const clientRequestId = randomUUID();
  const submitted = await editor.post(`${platform}/api/collaboration/scopes/${shared.id}/chat/requests`, {
    data: {
      clientRequestId,
      expectedRevision: capability.resourceRevision,
      text: "Reply with exactly: isolated shared Codex ready",
    },
  });
  expect(submitted.status()).toBe(201);
  const submittedBody = await submitted.json() as { request: { id: string } };

  await expect.poll(async () => {
    const requests = await owner.get(`${platform}/api/collaboration/scopes/${shared.id}/chat/requests`);
    if (!requests.ok()) return "unavailable";
    const body = await requests.json() as {
      requests: Array<{
        id: string;
        state: string;
        actor: { actorId: string };
        selection: { instanceId: string; model: string };
      }>;
    };
    const request = body.requests.find((candidate) => candidate.id === submittedBody.request.id);
    if (!request) return "missing";
    expect(request.actor.actorId).toBe(config.editorActorId);
    expect(request.selection).toEqual({ instanceId: "codex_default", model: "gpt-5.6-sol" });
    return request.state;
  }, { timeout: 120_000 }).toBe("completed");

  const editorRequests = await editor.get(`${platform}/api/collaboration/scopes/${shared.id}/chat/requests`);
  expect(editorRequests.ok()).toBe(true);
  expect(await editorRequests.json()).toMatchObject({
    requests: [expect.objectContaining({
      id: submittedBody.request.id,
      state: "completed",
      actor: { actorId: config.editorActorId },
      selection: { instanceId: "codex_default", model: "gpt-5.6-sol" },
    })],
  });
});
