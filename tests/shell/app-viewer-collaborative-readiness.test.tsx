// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppViewer } from "@/components/AppViewer";
import { subscribeOwnerAppSharing } from "@/lib/owner-app-sharing-events";

const fileWatcher = vi.hoisted(() => ({ callback: null as null | ((path: string, event: string) => void) }));
vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: (callback: (path: string, event: string) => void) => {
  fileWatcher.callback = callback;
} }));
vi.mock("@/lib/collaboration-organization-state", () => ({
  useCollaborationOrganization: () => ({ status: "member", organizationId: "org_matrix_team", organizationName: "Matrix team" }),
}));
vi.mock("@/hooks/useSocket", () => ({
  useSocket: () => ({ send: vi.fn(), subscribe: () => () => undefined }),
}));
vi.mock("@/lib/app-session", () => ({ openAppSession: vi.fn(async () => undefined) }));
vi.mock("@/lib/posthog-client", () => ({ capturePostHogEvent: vi.fn() }));
vi.mock("@/components/app-sites/AppSiteButton", () => ({
  AppSiteButton: () => <div data-testid="publish-app" />,
}));

const build = {
  appId: "team-tracker",
  catalogId: "50000000-0000-4000-8000-000000000001",
  registrationIncarnation: "a".repeat(64),
  manifestVersion: "1.0.0",
  buildId: "b".repeat(64),
  manifestDigest: "c".repeat(64),
  schemaDigest: "d".repeat(64),
  assetDigest: "e".repeat(64),
  bridgeContractVersion: "matrix-app-bridge-v1",
  runtimeAbi: "matrix-runtime-v1",
};
const ready = {
  readinessId: "60000000-0000-4000-8000-000000000001",
  build,
  status: "ready",
  revision: "3",
  checks: [{ code: "cleanup", status: "passed" }],
  verifiedAt: "2026-11-05T10:00:00.000Z",
};
let readiness: unknown;
beforeEach(() => {
  readiness = ready;
  fileWatcher.callback = null;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/api/collaboration/apps/team-tracker/readiness")) return Response.json(readiness);
    if (url.endsWith("/api/collaboration/apps/team-tracker/share")) return Response.json(null);
    if (url.endsWith("/apps/team-tracker/")) return new Response("<html><head></head><body>Tracker</body></html>");
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("AppViewer without a separate sharing bar", () => {
  it("leaves readiness and organization sharing to the window's Publish app popover", async () => {
    readiness = ready;
    render(<AppViewer path="apps/team-tracker" />);
    const iframe = screen.getByTitle("apps/team-tracker") as HTMLIFrameElement;
    await waitFor(() => expect(iframe.srcdoc).toContain("Tracker"));
    expect(screen.queryByLabelText("App collaboration readiness")).toBeNull();
    expect(screen.queryByRole("button", { name: /Manage app sharing|Share app|Check collaboration/ })).toBeNull();
    const fetchMock = vi.mocked(fetch);
    // The viewer still reads the share for its app bridge context, but no longer checks build readiness.
    expect(fetchMock.mock.calls.map(([input]) => String(input)).some((url) => url.includes("/readiness"))).toBe(false);
  });

  it("reports a rebuild of the open app so an open Publish app popover re-reads readiness", async () => {
    const rebuilt = vi.fn();
    const otherApp = vi.fn();
    const unsubscribe = subscribeOwnerAppSharing("team-tracker", "build-changed", rebuilt);
    const unsubscribeOther = subscribeOwnerAppSharing("notes", "build-changed", otherApp);
    render(<AppViewer path="apps/team-tracker" />);
    expect(rebuilt).not.toHaveBeenCalled();

    act(() => fileWatcher.callback?.("apps/team-tracker", "change"));
    await waitFor(() => expect(rebuilt).toHaveBeenCalledTimes(1));
    act(() => fileWatcher.callback?.("apps/notes", "change"));
    expect(rebuilt).toHaveBeenCalledTimes(1);
    expect(otherApp).not.toHaveBeenCalled();
    unsubscribe();
    unsubscribeOther();
  });
});
