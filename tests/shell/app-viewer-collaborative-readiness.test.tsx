// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppViewer } from "@/components/AppViewer";

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
const blocked = {
  readinessId: "60000000-0000-4000-8000-000000000001",
  build,
  status: "blocked",
  revision: "2",
  checks: [{ code: "two_principal_round_trip", status: "blocked", action: "A second authenticated verifier is not configured yet." }],
};
const ready = {
  ...blocked,
  status: "ready",
  revision: "3",
  checks: [{ code: "cleanup", status: "passed" }],
  verifiedAt: "2026-11-05T10:00:00.000Z",
};

let readiness: unknown;
beforeEach(() => {
  readiness = blocked;
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

describe("AppViewer collaborative readiness", () => {
  it("keeps the share entry disabled while the current exact build is blocked", async () => {
    const onShareApp = vi.fn();
    render(<AppViewer path="apps/team-tracker" onShareApp={onShareApp} />);
    const share = await screen.findByRole("button", { name: "Share app" });
    await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByLabelText("App collaboration readiness").textContent)
      .toContain("A second authenticated verifier is not configured yet.");
    fireEvent.click(share);
    expect(onShareApp).not.toHaveBeenCalled();
  });

  it("opens the share control only from a current ready certificate", async () => {
    readiness = ready;
    const onShareApp = vi.fn();
    render(<AppViewer path="apps/team-tracker" onShareApp={onShareApp} />);
    const share = await screen.findByRole("button", { name: "Share app" });
    await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(share);
    expect(onShareApp).toHaveBeenCalledWith("team-tracker");
  });

  it("lets the owner check a rebuilt app without reopening its viewer", async () => {
    readiness = ready;
    render(<AppViewer path="apps/team-tracker" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "Share app" }) as HTMLButtonElement).disabled).toBe(false));

    readiness = null;
    act(() => fileWatcher.callback?.("apps/team-tracker", "change"));

    expect(await screen.findByRole("button", { name: "Check collaboration" })).toBeTruthy();
    expect((screen.getByRole("button", { name: "Share app" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
