// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSiteButton } from "@/components/app-sites/AppSiteButton";
import { AppSiteOwnerIdentityProvider } from "@/components/app-sites/AppSiteOwnerIdentity";
import { MobileAppPublishButton } from "@/components/mobile/MobileAppPublishButton";
import { OrganizationStateProvider, type OrganizationMembershipState } from "@/lib/collaboration-organization-state";
import { OwnerCollaborationParticipantProvider } from "@/lib/owner-collaboration-participant";
import { notifyOwnerAppSharing, subscribeOwnerAppSharing } from "@/lib/owner-app-sharing-events";

const clerk = vi.hoisted(() => ({ calls: 0, throwIfCalled: false }));
vi.mock("@clerk/nextjs", () => ({
  useAuth: () => {
    clerk.calls += 1;
    if (clerk.throwIfCalled) throw new Error("useAuth can only be used within <ClerkProvider />");
    return { userId: "user_owner", isLoaded: true, isSignedIn: true };
  },
}));
vi.mock("@/components/app-sites/web-site-client", () => ({
  webSiteClient: { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null) },
}));

const build = {
  appId: "shared-tasks-lab", catalogId: "30000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64), manifestVersion: "1.0.0", buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64), schemaDigest: "d".repeat(64), assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1", runtimeAbi: "matrix-runtime-v1",
};
const ready = {
  readinessId: "40000000-0000-4000-8000-000000000001", build, status: "ready", revision: "2",
  checks: [{ code: "cleanup", status: "passed" }], verifiedAt: "2026-11-11T18:00:00.000Z",
};
const blocked = { ...ready, status: "blocked", revision: "3", checks: [{ code: "declaration", status: "blocked", action: "Declare collaborative capability." }] };
const activeShare = {
  scopeId: "10000000-0000-4000-8000-000000000001", organizationId: "org_matrix",
  owner: { actorId: "user_owner", displayName: "Owner" }, build, readinessId: ready.readinessId, state: "active",
  shareRevision: "3", bindingRevision: "4", dataRevision: "5",
  createdAt: "2026-11-11T18:00:00.000Z", updatedAt: "2026-11-11T18:00:00.000Z",
};
const roster = [
  { actorId: "user_piers", displayName: "Piers Cole", role: "org:member", joinedAt: "2026-11-11T18:00:00.000Z" },
  { actorId: "user_owner", displayName: "Nima Naderi", role: "org:admin", joinedAt: "2026-11-11T18:00:00.000Z" },
];

type Deferred = { promise: Promise<Response>; resolve: (value: Response) => void };
function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  return { promise: new Promise<Response>((done) => { resolve = done; }), resolve };
}

const server = {
  readiness: {} as Record<string, unknown>,
  share: {} as Record<string, unknown>,
  shareStatus: {} as Record<string, number>,
  pendingShare: {} as Record<string, Deferred | undefined>,
  requests: [] as { method: string; path: string; body: unknown }[],
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  clerk.calls = 0;
  clerk.throwIfCalled = false;
  server.readiness = { "shared-tasks-lab": ready, "team-tracker": ready };
  server.share = { "shared-tasks-lab": activeShare, "team-tracker": null };
  server.shareStatus = {};
  server.pendingShare = {};
  server.requests = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), window.location.origin);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    server.requests.push({ method, path: url.pathname + url.search, body });
    const app = url.pathname.match(/^\/api\/collaboration\/apps\/([^/]+)\/(readiness|share)(\/.*)?$/);
    if (app) {
      const [, appId, resource, rest] = app;
      if (resource === "readiness" && !rest) return json(server.readiness[appId!]);
      if (resource === "share" && rest === "/preflight") {
        return json({ eligible: true, catalogId: build.catalogId, resourceRevision: "7", readinessId: ready.readinessId,
          buildId: build.buildId, confirmationToken: "token-".padEnd(32, "x") });
      }
      if (resource === "share" && method === "POST") return json(server.share[appId!] = { ...activeShare });
      if (resource === "share" && method === "DELETE") return json(server.share[appId!] = { ...activeShare, state: "stopped" });
      if (resource === "share") {
        const pending = server.pendingShare[appId!];
        if (pending) return pending.promise;
        if (server.shareStatus[appId!]) return json({ error: "Database password authentication failed" }, server.shareStatus[appId!]);
        return json(server.share[appId!]);
      }
    }
    if (url.pathname === "/api/organizations") {
      return json({ complete: true, organizations: [
        { organizationId: "org_matrix", name: "Matrix team", slug: "matrix", role: "org:admin", memberCount: 2, aiSubmission: "owner_only", membershipEpoch: 1 },
        { organizationId: "org_other", name: "Other team", slug: "other", role: "org:member", memberCount: 1, aiSubmission: "owner_only", membershipEpoch: 1 },
      ] });
    }
    if (url.pathname.startsWith("/api/organizations/org_matrix/members")) return json({ members: roster });
    throw new Error(`Unexpected request: ${method} ${url.pathname}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const MEMBER: OrganizationMembershipState = { status: "member", organizationId: "org_matrix", organizationName: "Matrix team" };

function Window({ appSlug = "shared-tasks-lab", actorId = "user_owner", organization = MEMBER }: {
  appSlug?: string; actorId?: string; organization?: OrganizationMembershipState;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  return <OrganizationStateProvider value={organization}>
    <OwnerCollaborationParticipantProvider actorId={actorId}>
      <AppSiteOwnerIdentityProvider value="owner@example.com">
        <div ref={setPortalContainer} data-testid="app-window" className="relative">
          <AppSiteButton appSlug={appSlug} portalContainer={portalContainer} />
        </div>
      </AppSiteOwnerIdentityProvider>
    </OwnerCollaborationParticipantProvider>
  </OrganizationStateProvider>;
}

async function openPublish() {
  fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
  return screen.findByRole("dialog", { name: "Share app" });
}

function summaryRow(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: /Share with your organization|Shared with/ });
}

describe("Web Publish app organization sharing", () => {
  it("recognizes an existing share beside invite and publication, then stops it with both revisions", async () => {
    const shareChanged = vi.fn();
    const unsubscribe = subscribeOwnerAppSharing("shared-tasks-lab", "share-changed", shareChanged);
    render(<Window />);
    const dialog = await openPublish();
    expect(screen.getByTestId("app-window").contains(dialog)).toBe(true);
    expect(within(dialog).getByText("Invite by link, publish at a URL, or share with your organization.")).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Invite" })).toBeTruthy();

    const summary = await within(dialog).findByRole("button", { name: /Shared with Matrix team/ });
    expect(summary.querySelector('[data-sharing-status="active"]')).toBeTruthy();
    expect(summary.textContent).toContain("Active for all current members");

    fireEvent.click(summary);
    const title = await within(dialog).findByRole("heading", { name: "Organization sharing" });
    expect(document.activeElement).toBe(title);
    const members = await within(dialog).findByRole("list", { name: "Members of Matrix team" });
    expect(within(members).getByText("Piers Cole")).toBeTruthy();
    expect(within(members).getByText("(you)")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Stop sharing" }));
    await within(within(dialog).getByRole("region", { name: "Share with your org" })).findAllByText("Sharing stopped");
    expect(server.requests).toContainEqual({
      method: "DELETE", path: "/api/collaboration/apps/shared-tasks-lab/share",
      body: expect.objectContaining({ expectedShareRevision: "3", expectedBindingRevision: "4" }),
    });
    await waitFor(() => expect(shareChanged).toHaveBeenCalledTimes(1));
    unsubscribe();
  });

  it("shares a private app through readiness and a fresh preflight with the current revisions", async () => {
    render(<Window appSlug="team-tracker" />);
    const dialog = await openPublish();
    const summary = await within(dialog).findByRole("button", { name: /Share with your organization/ });
    await waitFor(() => expect(summary.textContent).toContain("Matrix team · Not shared"));
    expect(summary.querySelector('[data-sharing-status="not_shared"]')).toBeTruthy();

    fireEvent.click(summary);
    await within(dialog).findByText("Ready to share");
    expect(within(dialog).getByText("App build:")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Share with your org" }));
    await within(dialog).findAllByText("Active for all current members");
    expect(server.requests).toContainEqual({
      method: "POST", path: "/api/collaboration/apps/team-tracker/share/preflight",
      body: { organizationId: "org_matrix", expectedReadinessRevision: "2", expectedBuildId: build.buildId },
    });
    expect(server.requests).toContainEqual({
      method: "POST", path: "/api/collaboration/apps/team-tracker/share",
      body: expect.objectContaining({ organizationId: "org_matrix", expectedResourceRevision: "7", expectedReadinessRevision: "2", buildId: build.buildId }),
    });
  });

  it("keeps sharing disabled with the corrective action while the build is blocked", async () => {
    server.readiness["team-tracker"] = blocked;
    render(<Window appSlug="team-tracker" />);
    const dialog = await openPublish();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Share with your organization/ }));
    await within(dialog).findByText("Declare collaborative capability.");
    expect((within(dialog).getByRole("button", { name: "Share with your org" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows loading, then a safe unavailable state without an active indicator when the share read fails", async () => {
    server.pendingShare["shared-tasks-lab"] = deferred();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<Window />);
    const dialog = await openPublish();
    const summary = await within(dialog).findByRole("button", { name: /Share with your organization/ });
    expect(summary.textContent).toContain("Checking sharing status…");
    expect(summary.querySelector('[data-sharing-status="loading"]')).toBeTruthy();

    await act(async () => { server.pendingShare["shared-tasks-lab"]!.resolve(json({ error: "Database password authentication failed" }, 500)); });
    await waitFor(() => expect(summaryRow(dialog).textContent).toContain("Sharing status unavailable"));
    expect(dialog.querySelector('[data-sharing-status="active"]')).toBeNull();
    expect(dialog.textContent).not.toMatch(/password|Database/i);
  });

  it("asks for a recheck instead of reporting an active share after the build changed", async () => {
    server.share["shared-tasks-lab"] = { ...activeShare, state: "needs_recheck" };
    render(<Window />);
    const dialog = await openPublish();
    const summary = await within(dialog).findByRole("button", { name: /Shared with Matrix team/ });
    await waitFor(() => expect(summary.textContent).toContain("Sharing needs a recheck"));
    expect(summary.querySelector('[data-sharing-status="needs_recheck"]')).toBeTruthy();
    fireEvent.click(summary);
    fireEvent.click(await within(dialog).findByRole("button", { name: "Check collaboration" }));
    await waitFor(() => expect(server.requests.some((request) => request.method === "POST"
      && request.path === "/api/collaboration/apps/shared-tasks-lab/readiness/check"
      && (request.body as { organizationId?: string }).organizationId === "org_matrix")).toBe(true));
  });

  it("re-reads readiness when the open app reports a rebuild", async () => {
    render(<Window />);
    await openPublish();
    const readinessReads = () => server.requests.filter((request) => request.path === "/api/collaboration/apps/shared-tasks-lab/readiness").length;
    await waitFor(() => expect(readinessReads()).toBe(1));
    act(() => { notifyOwnerAppSharing("team-tracker", "build-changed"); });
    act(() => { notifyOwnerAppSharing("shared-tasks-lab", "build-changed"); });
    await waitFor(() => expect(readinessReads()).toBe(2));
  });

  it("never applies a late share read to another app or account", async () => {
    server.pendingShare["shared-tasks-lab"] = deferred();
    const view = render(<Window />);
    const dialog = await openPublish();
    await within(dialog).findByRole("button", { name: /Checking sharing status|Share with your organization/ });

    // The window now shows a different app (and then a different account) while the first read is in flight.
    view.rerender(<Window appSlug="team-tracker" />);
    await waitFor(() => expect(summaryRow(dialog).textContent).toContain("Not shared"));
    view.rerender(<Window appSlug="team-tracker" actorId="user_second" />);
    await waitFor(() => expect(summaryRow(dialog).textContent).toContain("Not shared"));
    await act(async () => { server.pendingShare["shared-tasks-lab"]!.resolve(json(activeShare)); });

    expect(dialog.querySelector('[data-sharing-status="active"]')).toBeNull();
    expect(within(dialog).queryByText(/Shared with Matrix team/)).toBeNull();
  });

  it("returns focus to the trigger on Escape from the details view", async () => {
    render(<Window />);
    const trigger = screen.getByRole("button", { name: "Publish app" });
    const dialog = await openPublish();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Shared with Matrix team/ }));
    await within(dialog).findByRole("heading", { name: "Organization sharing" });
    fireEvent.keyDown(document.activeElement ?? document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps invite and publication without an organization context and never needs Clerk", async () => {
    clerk.throwIfCalled = true;
    server.share["shared-tasks-lab"] = null;
    render(<Window organization={{ status: "none", organizationId: null }} />);
    const dialog = await openPublish();
    expect(within(dialog).getByRole("heading", { name: "Invite" })).toBeTruthy();
    const summary = await within(dialog).findByRole("button", { name: /Share with your organization/ });
    await waitFor(() => expect(summary.textContent).toContain("Select an organization to share this app."));
    expect(clerk.calls).toBe(0);
  });
});

describe("Web organization sharing recovery", () => {
  it("retries an unavailable member roster", async () => {
    let rosterFailures = 1;
    const base = vi.mocked(fetch).getMockImplementation()!;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname.startsWith("/api/organizations/org_matrix/members") && rosterFailures-- > 0) {
        return json({ error: "upstream" }, 503);
      }
      return base(input, init);
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(<Window />);
    const dialog = await openPublish();
    fireEvent.click(await within(dialog).findByRole("button", { name: /Shared with Matrix team/ }));
    await within(dialog).findByText("Members are unavailable.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByRole("list", { name: "Members of Matrix team" })).toBeTruthy();
  });

  it("says organizations are unavailable instead of offering a share target", async () => {
    server.share["shared-tasks-lab"] = null;
    render(<Window organization={{ status: "unavailable", organizationId: null }} />);
    const dialog = await openPublish();
    const summary = await within(dialog).findByRole("button", { name: /Share with your organization/ });
    await waitFor(() => expect(summary.textContent).toContain("Organizations are unavailable. Try again later."));
  });

  it("ignores malformed or unrelated sharing events", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeOwnerAppSharing("shared-tasks-lab", "share-changed", listener);
    window.dispatchEvent(new CustomEvent("matrix:owner-app-sharing", { detail: { appId: "shared-tasks-lab", kind: "deleted" } }));
    window.dispatchEvent(new CustomEvent("matrix:owner-app-sharing", { detail: "shared-tasks-lab" }));
    window.dispatchEvent(new CustomEvent("matrix:owner-app-sharing", { detail: null }));
    notifyOwnerAppSharing("shared-tasks-lab", "build-changed");
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    notifyOwnerAppSharing("shared-tasks-lab", "share-changed");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("Web Mobile Publish app entry", () => {
  function MobileHeader({ path, shared = false }: { path: string; shared?: boolean }) {
    return <OrganizationStateProvider value={MEMBER}>
      <OwnerCollaborationParticipantProvider actorId="user_owner">
        <header><MobileAppPublishButton path={path} shared={shared} /></header>
      </OwnerCollaborationParticipantProvider>
    </OrganizationStateProvider>;
  }

  it("offers the same organization sharing for the open owner app", async () => {
    render(<MobileHeader path="apps/shared-tasks-lab/index.html" />);
    const dialog = await openPublish();
    expect(await within(dialog).findByRole("button", { name: /Shared with Matrix team/ })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Invite" })).toBeTruthy();
  });

  it.each([
    ["a shared app opened from another owner", "apps/shared-tasks-lab/index.html", true],
    ["a built-in app", "__terminal__", false],
  ])("is absent for %s", (_label, path, shared) => {
    render(<MobileHeader path={path} shared={shared} />);
    expect(screen.queryByRole("button", { name: "Publish app" })).toBeNull();
  });
});
