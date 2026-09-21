import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { hashGitAction, ProjectGitBrokerError } from "../../packages/gateway/src/collaboration/project-git-broker.js";
import { registerProjectRoutes } from "../../packages/gateway/src/collaboration/project-routes.js";
import type { CollaborationRouteOptions } from "../../packages/gateway/src/collaboration/route-support.js";

const scopeId = "90000000-0000-4000-8000-000000000001";
const actorId = "user_git_member";
const operation = {
  id: "90000000-0000-4000-8000-000000000002",
  scopeId,
  type: "commit" as const,
  state: "completed" as const,
  requestingActorId: actorId,
  ownerIdentityLabel: "Owner <owner@example.test>",
  commitSha: "a".repeat(40),
  createdAt: "2026-09-21T10:00:00.000Z",
  updatedAt: "2026-09-21T10:00:00.000Z",
};

function fixture(input: { submit?: () => Promise<unknown>; expireUnresolved?: () => Promise<unknown> } = {}) {
  const submit = vi.fn(input.submit ?? (async () => operation));
  const list = vi.fn(async () => [operation]);
  const expireUnresolved = vi.fn(input.expireUnresolved ?? (async () => ({ ...operation, type: "push" as const, state: "failed" as const })));
  const verifyAndAuthorize = vi.fn(async () => ({
    actorId,
    ownerId: "user_git_owner",
    organizationId: "org_git_routes",
    scopeId,
    membershipScopeId: scopeId,
    resourceKind: "project",
    resourceId: "proj_git_routes",
    role: "editor",
    authEpoch: 1,
    authorityRuntimeId: "runtime_git_routes",
    authorityGeneration: 1,
    capability: "mutate_project",
  }));
  const getReadiness = vi.fn(async () => ({
    scopeId,
    chatRoots: [{ chatId: "chat_one", executionRoot: { kind: "worktree", projectId: "proj_git_routes", worktreeId: "wt_one" }, branch: "feature/chat", dirty: true, readiness: "ready" }],
    gitSetup: { identity: { status: "ready", label: "Owner <owner@example.test>" }, forgeCredential: { status: "ready" } },
  }));
  const app = new Hono();
  registerProjectRoutes(app, {
    verifier: { verifyAndAuthorize },
    projectGit: { submit, list, expireUnresolved },
    projectReadiness: { get: getReadiness },
  } as unknown as CollaborationRouteOptions);
  const headers = { "content-type": "application/json", "x-matrix-collaboration-proof": "e30" };
  return { app, submit, list, expireUnresolved, getReadiness, verifyAndAuthorize, headers };
}

describe("project Git routes", () => {
  it("validates a bounded action union and sends the authenticated actor to the broker", async () => {
    const { app, submit, verifyAndAuthorize, headers } = fixture();
    const input = {
      type: "commit",
      clientRequestId: "90000000-0000-4000-8000-000000000003",
      expectedRevision: "1",
      message: "feat: member change",
      expectedHeadSha: "b".repeat(40),
    };
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/actions`, {
      method: "POST", headers, body: JSON.stringify({ ...input, payloadHash: hashGitAction(input) }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject(operation);
    expect(verifyAndAuthorize).toHaveBeenCalledWith(expect.objectContaining({ action: "mutate_project" }));
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ scopeId, actorId, request: expect.objectContaining({ type: "commit" }) }));

    const unsafe = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/actions`, {
      method: "POST", headers, body: JSON.stringify({ ...input, payloadHash: hashGitAction(input), token: "raw-secret" }),
    });
    expect(unsafe.status).toBe(400);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("returns only bounded Chat root and Git setup readiness after read authorization", async () => {
    const { app, getReadiness, verifyAndAuthorize, headers } = fixture();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/project/readiness`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ scopeId, chatRoots: [expect.objectContaining({ chatId: "chat_one", dirty: true })] });
    expect(getReadiness).toHaveBeenCalledWith({ scopeId });
    expect(verifyAndAuthorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read" }));
  });

  it("lets the authenticated owner expire an unresolved operation by validated ID only", async () => {
    const { app, expireUnresolved, verifyAndAuthorize, headers } = fixture();
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/${operation.id}/expire`, { method: "POST", headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: operation.id, state: "failed" });
    expect(verifyAndAuthorize).toHaveBeenCalledWith(expect.objectContaining({ action: "mutate_project" }));
    expect(expireUnresolved).toHaveBeenCalledWith({ scopeId, actorId, operationId: operation.id });
    const invalid = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/not-a-uuid/expire`, { method: "POST", headers });
    expect(invalid.status).toBe(400);
    expect(expireUnresolved).toHaveBeenCalledTimes(1);
  });

  it("maps a member expiry attempt to a generic forbidden response", async () => {
    const { app, headers } = fixture({ expireUnresolved: async () => { throw new ProjectGitBrokerError("forbidden"); } });
    const response = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/${operation.id}/expire`, { method: "POST", headers });
    expect(response.status).toBe(403);
    expect(JSON.stringify(await response.json())).not.toContain("Project Git operation");
  });

  it("returns a generic denial and lists only through read authorization", async () => {
    const { app, list, headers } = fixture({ submit: async () => { throw new ProjectGitBrokerError("forbidden"); } });
    const input = {
      type: "commit",
      clientRequestId: "90000000-0000-4000-8000-000000000004",
      expectedRevision: "1",
      message: "feat: denied",
      expectedHeadSha: "b".repeat(40),
    };
    const denied = await app.request(`/api/collaboration/scopes/${scopeId}/project/git/actions`, {
      method: "POST", headers, body: JSON.stringify({ ...input, payloadHash: hashGitAction(input) }),
    });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(await denied.json())).not.toContain("Project Git operation");

    const response = await app.request(`/api/collaboration/scopes/${scopeId}/project/git`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([operation]);
    expect(list).toHaveBeenCalledWith({ scopeId, actorId });
  });
});
