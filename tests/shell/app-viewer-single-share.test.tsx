// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppViewer } from "@/components/AppViewer";

vi.mock("@/hooks/useFileWatcher", () => ({ useFileWatcher: () => undefined }));
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

const requests: string[] = [];
beforeEach(() => {
  requests.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/apps/team-tracker/") || url.endsWith("/apps/notes/")) return new Response("<html><head></head><body>App</body></html>");
    if (url.includes("/api/collaboration/")) return Response.json(null);
    throw new Error(`Unexpected request: ${url}`);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// User outcome: an organization member sees one Share entry point (the window
// title bar's Share popover, whose Organization tab handles org sharing), like
// Electron Desktop. Fault: the retired in-app collaboration bar ("Check
// collaboration" / "Share app") rendering as a second share control on Web.
describe("AppViewer share entry point", () => {
  it("renders no in-app collaboration share bar for an organization member", async () => {
    render(<AppViewer path="apps/team-tracker" />);

    await waitFor(() => expect(requests.some((url) => url.endsWith("/apps/team-tracker/"))).toBe(true));
    expect(screen.queryByRole("button", { name: "Share app" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Check collaboration" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage app sharing" })).toBeNull();
  });

  // Web Mobile has no title-bar Share, so its inline control is the only org-sharing
  // entry point. Faults: Web Mobile losing org sharing, or offering it on default apps.
  it("keeps the inline organization share on Web Mobile for an app the owner built", async () => {
    render(<AppViewer path="apps/team-tracker" inlineShareControls />);

    expect(await screen.findByRole("button", { name: /Share app|Manage app sharing/ })).toBeTruthy();
  });

  it("shows no inline share on Web Mobile for a Matrix default app", async () => {
    render(<AppViewer path="apps/notes" inlineShareControls />);

    await waitFor(() => expect(requests.some((url) => url.endsWith("/apps/notes/"))).toBe(true));
    expect(screen.queryByRole("button", { name: /Share app|Check collaboration|Manage app sharing/ })).toBeNull();
  });
});
