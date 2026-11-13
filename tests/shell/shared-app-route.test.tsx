// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";

// Fault protected: a recipient's native shared-app view at /shared/app/<scope>
// booted the recipient's personal Matrix desktop (OnboardingGate + ShellHome:
// dock, system apps, "Computer unavailable") instead of the owner's shared app.
// The route, collaboration client, and viewer are real; only the network edge
// (fetch) and Next request primitives are substituted.

const mocks = vi.hoisted(() => ({
  headers: new Headers(),
  personalDesktop: vi.fn(),
  onboardingGate: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => mocks.headers }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@clerk/nextjs", () => ({ useAuth: () => ({ isLoaded: true, userId: null }) }));
// Sentinels only: the fixed route must never mount the recipient's personal shell.
vi.mock("@/components/ShellHome", () => ({
  ShellHome: () => { mocks.personalDesktop(); return <div data-testid="personal-desktop" />; },
}));
vi.mock("@/components/OnboardingGate", () => ({
  OnboardingGate: ({ children }: { children: React.ReactNode }) => { mocks.onboardingGate(); return <>{children}</>; },
}));

import SharedAppPage from "../../shell/src/app/shared/app/[scopeId]/page.js";
import { shouldAuthorizeSharedAppRequest } from "@desktop/main/embeds/web-contents-view";

const target: CollaborativeAppDirectoryItem = {
  scopeId: "10000000-0000-4000-8000-000000000001",
  runtimeId: "vps:20000000-0000-4000-8000-000000000001",
  organizationId: "org_matrix_team",
  authorityGeneration: 1,
  appId: "tasks-lab",
  catalogId: "30000000-0000-4000-8000-000000000001",
  readinessId: "40000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  buildId: "b".repeat(64),
  shareRevision: "3",
  owner: { actorId: "user_owner", displayName: "Nima" },
};

type Seen = { method: string; url: string };

function nativeHeaders(actorId = "user_piers"): Headers {
  return new Headers({ "x-matrix-platform-session": "native", "x-platform-user-id": actorId });
}

function stubSharedAppNetwork(directory: CollaborativeAppDirectoryItem | "denied" = target): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin);
    const method = (init?.method ?? "GET").toUpperCase();
    seen.push({ method, url: url.href });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { "content-type": "application/json" },
    });
    if (method === "GET" && url.pathname === `/api/collaboration/shared-apps/${target.scopeId}`) {
      return directory === "denied" ? json({ error: "Not found" }, 404) : json(directory);
    }
    if (method === "POST" && url.pathname === `/api/collaboration/shared-apps/${target.scopeId}/launch`) {
      return json({
        target: {
          kind: "shared", scopeId: target.scopeId, organizationId: target.organizationId, appId: target.appId,
          catalogId: target.catalogId, buildId: target.buildId, name: "Shared tasks lab", owner: target.owner,
          shareRevision: target.shareRevision,
        },
        launchId: "50000000-0000-4000-8000-000000000001",
        entryUrl: `/api/collaboration/shared-apps/${target.scopeId}/runtime/50000000-0000-4000-8000-000000000001/index.html`,
        expiresAt: "2026-11-13T13:00:00.000Z",
      });
    }
    return json({ error: "Unavailable" }, 503);
  }));
  return seen;
}

async function renderRoute(query: Record<string, string> = {
  expectedBuildId: target.buildId, expectedShareRevision: target.shareRevision,
}) {
  const element = await SharedAppPage({
    params: Promise.resolve({ scopeId: target.scopeId }),
    searchParams: Promise.resolve(query),
  });
  return render(element);
}

beforeEach(() => {
  mocks.headers = nativeHeaders();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("native shared-app route", () => {
  it("renders the owner's exact shared build without booting the recipient's personal desktop", async () => {
    const seen = stubSharedAppNetwork();

    await renderRoute();

    const app = await screen.findByTitle("Tasks lab shared by Nima");
    expect(app.tagName).toBe("IFRAME");
    expect(app.getAttribute("src")).toBe(
      `/api/collaboration/shared-apps/${target.scopeId}/runtime/50000000-0000-4000-8000-000000000001/index.html`,
    );
    expect(app.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(screen.queryByTestId("personal-desktop")).toBeNull();
    expect(mocks.personalDesktop).not.toHaveBeenCalled();
    expect(mocks.onboardingGate).not.toHaveBeenCalled();
    expect(screen.queryByText(/Computer unavailable/i)).toBeNull();

    // The launch binds the owner's exact build/share identity, never a recipient app.
    const launch = vi.mocked(fetch).mock.calls.find(([input]) => String(input).endsWith("/launch"));
    expect(JSON.parse(String(launch?.[1]?.body))).toMatchObject({
      expectedBuildId: target.buildId, expectedShareRevision: target.shareRevision,
    });
    // Electron attaches the native bearer only to this allowlist. Any request the
    // page needs outside it (a personal runtime/gateway call) breaks the native view.
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(shouldAuthorizeSharedAppRequest({
        requestUrl: request.url,
        gatewayOrigin: window.location.origin,
        scopeId: target.scopeId,
        appId: target.appId,
        method: request.method,
        mainFrame: true,
      }), `${request.method} ${new URL(request.url).pathname}`).toBe(true);
    }
  });

  it("fails closed when the share moved to another build or revision", async () => {
    stubSharedAppNetwork({ ...target, buildId: "c".repeat(64) });

    await renderRoute();

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Shared app unavailable"));
    expect(screen.queryByTitle("Tasks lab shared by Nima")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).endsWith("/launch"))).toBe(false);
  });

  it("denies a stopped share or removed member without opening the app", async () => {
    stubSharedAppNetwork("denied");

    await renderRoute();

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Shared app unavailable"));
    expect(screen.queryByTitle("Tasks lab shared by Nima")).toBeNull();
    expect(mocks.personalDesktop).not.toHaveBeenCalled();
  });

  it("rejects malformed scope or build targets at the route boundary", async () => {
    stubSharedAppNetwork();
    await expect(SharedAppPage({
      params: Promise.resolve({ scopeId: "../apps" }),
      searchParams: Promise.resolve({}),
    })).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(renderRoute({ expectedBuildId: "not-a-build", expectedShareRevision: "3" })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows a safe notice on self-hosted installs instead of a Clerk-dependent viewer", async () => {
    vi.stubEnv("MATRIX_SELF_HOSTED", "1");
    mocks.headers = new Headers();
    stubSharedAppNetwork();

    await renderRoute();

    expect(screen.getByRole("alert").textContent).toContain("Shared apps require a Matrix account.");
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it("does not trust an unverified native identity header", async () => {
    mocks.headers = new Headers({ "x-matrix-platform-session": "platform", "x-platform-user-id": "user_spoofed" });
    stubSharedAppNetwork();

    await renderRoute();

    expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("authenticated Matrix account"));
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.personalDesktop).not.toHaveBeenCalled();
  });
});
