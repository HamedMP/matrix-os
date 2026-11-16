// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// Outcome: with the email-invite preview flag on, both header hosts show the
// Private tab with the owner's identity. Faults: the build-time flag not
// reaching the shared popover, or Electron losing its user-ID initial fallback.
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_MATRIX_SHARE_EMAIL_INVITES_PREVIEW = "1";
  process.env.VITE_MATRIX_SHARE_EMAIL_INVITES_PREVIEW = "1";
});

const fixture = vi.hoisted(() => ({
  client: { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null), slugAvailability: vi.fn(async () => ({ status: "available", suggestions: [] })) },
  connection: { api: { forRuntime: () => null } as object | null, runtimeSlot: "primary", authGeneration: 0, email: null as string | null, userId: "user_fallback" as string | null },
}));
vi.mock("../../shell/src/components/app-sites/web-site-client", () => ({ webSiteClient: fixture.client }));
vi.mock("../../shell/src/components/app-sites/use-web-share-organization", () => ({ useWebShareOrganization: () => ({ slot: null, shared: false }) }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/use-desktop-share-organization", () => ({ useDesktopShareOrganization: () => ({ slot: null, shared: false }) }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => fixture.client }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (state: typeof fixture.connection) => unknown) => select(fixture.connection) }));
vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({ useUi: (select: (state: { acquireRendererOverlay: () => void; releaseRendererOverlay: () => void }) => unknown) => select({ acquireRendererOverlay: vi.fn(), releaseRendererOverlay: vi.fn() }) }));

const { AppSiteButton } = await import("../../shell/src/components/app-sites/AppSiteButton");
const { AppSiteOwnerIdentityProvider } = await import("../../shell/src/components/app-sites/AppSiteOwnerIdentity");
const { DesktopAppSiteButton } = await import("../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton");

afterEach(cleanup);

async function openPrivateTab() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  const dialog = await screen.findByRole("dialog", { name: "Share app" });
  fireEvent.mouseDown(within(dialog).getByRole("tab", { name: /Private/ }), { button: 0 });
  return dialog;
}

describe("email-invite preview", () => {
  it("shows the Private tab with the owner on Web", async () => {
    render(<AppSiteOwnerIdentityProvider value="owner@example.com"><AppSiteButton appSlug="launch" /></AppSiteOwnerIdentityProvider>);
    const dialog = await openPrivateTab();
    expect(within(dialog).getByText("You")).toBeTruthy();
    expect(within(dialog).getByText("Owner")).toBeTruthy();
    expect(within(dialog).getByText("O")).toBeTruthy();
  });

  it("uses the Electron user ID initial when the account has no email", async () => {
    render(<DesktopAppSiteButton appSlug="launch" />);
    const dialog = await openPrivateTab();
    expect(within(dialog).getByText("U")).toBeTruthy();
  });
});
