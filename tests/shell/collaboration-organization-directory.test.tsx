// @vitest-environment jsdom
/**
 * Share and drives read the organization directory through the real direct
 * API: `createCollaborationDirectApi` -> browser client -> the platform
 * organization routes. Scope requests still travel the signed direct path to
 * the fake home, so only the organization reads change transport.
 */
import React from "react";
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlatformOrganizationRoutes } from "../../packages/platform/src/organizations/routes.js";
import { createCollaborationDirectApi } from "../../packages/ui/src/collaboration/direct-api.js";
import { AudienceGrantPicker } from "../../packages/ui/src/collaboration/AudienceGrantPicker.js";
import {
  CLIENT_ORIGIN, PLATFORM, RELAY, actorId, fakeDirectWorld, organizationId, otherScopeId, runtimeId, scopeId,
} from "../helpers/collaboration-direct-world.js";

const harness = vi.hoisted(() => ({ createApi: null as null | ((baseUrl: string) => unknown) }));
vi.mock("@/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => "https://app.matrix-os.com" }));
vi.mock("@/lib/collaboration", () => ({
  createShellCollaborationApi: (baseUrl: string) => harness.createApi!(baseUrl),
  releaseShellCollaborationApi: vi.fn(),
}));

import { OrganizationDrivesView } from "../../shell/src/components/file-browser/OrganizationDrivesView.js";

const ACTOR_TOKEN = "Bearer actor-token";
const others = Array.from({ length: 54 }, (_, index) => `user_member_${String(index).padStart(2, "0")}`);
const memberIds = [actorId, ...others].sort();
const ownerScope = {
  id: scopeId, ownerId: actorId, organizationId, kind: "chat" as const, resourceId: "chat_shared",
  membershipMode: "direct" as const, lifecycle: "shared" as const, revision: "2", authEpoch: "2", authorityGeneration: "3",
  role: "owner" as const,
  capabilities: { read: true, discuss: true, manageMembers: true, requestAi: true, observeTerminal: false, controlTerminal: false, stopTerminal: false },
};

function organizationRoutes() {
  const record = (id: string) => ({ actorId: id, role: id === actorId ? "org:admin" : "org:member", sourceUpdatedAt: new Date("2026-09-20T12:00:00.000Z") });
  const repository = {
    listOrganizationsForActor: async (id: string) => memberIds.includes(id) ? [{
      organization: { organizationId, name: "Direct org", slug: "direct-org", aiSubmission: "members", membershipEpoch: 4 },
      membership: record(id),
    }] : [],
    listMemberCounts: async (organizationIds: string[]) => new Map(
      organizationIds.map((id) => [id, id === organizationId ? memberIds.length : 0]),
    ),
    listMembers: async (_organizationId: string, page: { limit: number; afterActorId?: string }) => {
      const remaining = memberIds.filter((id) => !page.afterActorId || id > page.afterActorId);
      const members = remaining.slice(0, page.limit).map(record);
      return remaining.length > page.limit ? { members, nextActorId: members[members.length - 1]!.actorId } : { members };
    },
  };
  return createPlatformOrganizationRoutes({
    repository: repository as never,
    projection: {
      discoverOrganizationsForActor: async () => ({ complete: true }),
      isCurrentMember: async (input: { organizationId: string; actorId: string }) => input.organizationId === organizationId && memberIds.includes(input.actorId),
    } as never,
    controlAuthority: {} as never,
    // The platform resolves the actor from the credential the client sent.
    resolveActor: async (c: Context) => c.req.header("authorization") === ACTOR_TOKEN ? actorId : null,
    authenticateRuntime: async () => null,
  });
}

describe("organization directory reads through the direct API", () => {
  let world: ReturnType<typeof fakeDirectWorld>;
  let organizationRequests: Array<{ url: string; credentials: RequestCredentials | undefined }>;

  beforeEach(() => {
    world = fakeDirectWorld();
    organizationRequests = [];
    const routes = organizationRoutes();
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.origin === PLATFORM && url.pathname.startsWith("/api/organizations")) {
        organizationRequests.push({ url: url.href, credentials: init?.credentials });
        return routes.request(url.href, init);
      }
      const response = await world.fetchImpl(input, init);
      // The fake home verifies the session signature first; these owner fixtures answer only accepted requests.
      if (url.origin === RELAY && response.status !== 401) {
        if (url.pathname === `/api/collaboration/scopes/${scopeId}`) return json(ownerScope);
        if (url.pathname === `/api/collaboration/scopes/${scopeId}/grants`) return json([]);
      }
      return response;
    };
    harness.createApi = (baseUrl) => createCollaborationDirectApi({
      platformBaseUrl: baseUrl, clientOrigin: CLIENT_ORIGIN, fetchImpl, webSocketFactory: world.webSocketFactory, now: world.now,
      getHeaders: async () => ({ Authorization: ACTOR_TOKEN }),
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("loads the Share member picker and its next page from the platform directory", async () => {
    const api = harness.createApi!(PLATFORM) as Parameters<typeof AudienceGrantPicker>[0]["api"];
    render(<AudienceGrantPicker api={api} scope={ownerScope} />);
    await waitFor(() => expect(screen.queryByText("Loading organization members…")).not.toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    const audience = screen.getByRole("combobox", { name: "Share with" });
    expect(within(audience).getByRole("option", { name: "user_member_00" })).toBeInTheDocument();
    expect(within(audience).queryByRole("option", { name: actorId })).not.toBeInTheDocument();
    expect(within(audience).queryByRole("option", { name: "user_member_53" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "More members" }));
    await waitFor(() => expect(within(audience).getByRole("option", { name: "user_member_53" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "More members" })).not.toBeInTheDocument();
    expect(within(audience).getAllByRole("option")).toHaveLength(others.length + 1);

    expect(organizationRequests.map((request) => new URL(request.url).pathname + new URL(request.url).search)).toEqual([
      `/api/organizations/${organizationId}/members`,
      expect.stringMatching(new RegExp(`^/api/organizations/${organizationId}/members\\?cursor=[A-Za-z0-9_-]+$`)),
    ]);
    expect(organizationRequests.every((request) => request.credentials === "same-origin")).toBe(true);
  });

  it("lists organization drives with names from the platform directory", async () => {
    world.platform.inbox.push({
      scopeId: otherScopeId, runtimeId, ownerId: "user_owner", kind: "folder", authorityGeneration: 3,
      status: "organization_pending", organizationId, grantId: "30000000-0000-4000-8000-000000000001",
    });
    render(<OrganizationDrivesView />);
    const drives = await screen.findByRole("navigation", { name: "Organization drives" });
    expect(within(drives).getByRole("button", { name: "Direct org" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open organization share" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(organizationRequests.map((request) => request.url)).toContain(`${PLATFORM}/api/organizations`);
  });
});
