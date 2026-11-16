// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSiteButton } from "../../shell/src/components/app-sites/AppSiteButton";
import { AppSiteOwnerIdentityProvider } from "../../shell/src/components/app-sites/AppSiteOwnerIdentity";
import { DesktopAppSiteButton } from "../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";

const fixture = vi.hoisted(() => {
  const client = { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null), slugAvailability: vi.fn(async () => ({ status: "available", suggestions: [] })) };
  const connection = { api: { forRuntime: () => null } as object | null, runtimeSlot: "primary", authGeneration: 0, email: "owner@example.com" as string | null, userId: "user_owner" as string | null };
  return { client, connection, acquire: vi.fn(), release: vi.fn() };
});
vi.mock("../../shell/src/components/app-sites/web-site-client", () => ({ webSiteClient: fixture.client }));
// Org listing needs Clerk; the Organization tab has its own suite (share-organization.test.tsx).
vi.mock("../../shell/src/components/app-sites/use-web-share-organization", () => ({ useWebShareOrganization: () => ({ slot: null, shared: false }) }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/use-desktop-share-organization", () => ({ useDesktopShareOrganization: () => ({ slot: null, shared: false }) }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => fixture.client }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (state: typeof fixture.connection) => unknown) => select(fixture.connection) }));
vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({ useUi: (select: (state: { acquireRendererOverlay: () => void; releaseRendererOverlay: () => void }) => unknown) => select({ acquireRendererOverlay: fixture.acquire, releaseRendererOverlay: fixture.release }) }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.client.get.mockImplementation(async () => null);
  fixture.connection.api = { forRuntime: () => null }; fixture.connection.runtimeSlot = "primary"; fixture.connection.authGeneration = 0;
  fixture.connection.email = "owner@example.com"; fixture.connection.userId = "user_owner";
});
afterEach(cleanup);

const rsvpForm = { id: "rsvp", title: "RSVP", fields: { email: { type: "email", required: true } } };
function siteRecord({ status, forms }: { status: "published" | "unpublished"; forms: unknown[] }) {
  const siteId = "11111111-1111-4111-8111-111111111111";
  return { id: siteId, appSlug: "launch", title: "Launch", description: "", slug: null, url: `https://matrix.page/${siteId}`, revision: 4, status, accessMode: "public", activeVersion: null, versions: [], config: { data: {}, forms } };
}

function ContainedTrigger({
  Component,
  appSlug = "launch",
}: {
  Component: typeof AppSiteButton | typeof DesktopAppSiteButton;
  appSlug?: string;
}) {
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null);
  return <div ref={setPortalContainer} data-testid="created-app-surface" className="relative">
    <AppSiteOwnerIdentityProvider value="owner@example.com">
      <Component appSlug={appSlug} portalContainer={portalContainer} />
    </AppSiteOwnerIdentityProvider>
  </div>;
}

it("keeps Web sharing inside a maximized app window", async () => {
  render(<div style={{ position:"fixed",zIndex:SHELL_Z_INDEX.fullscreenWindow }}><ContainedTrigger Component={AppSiteButton} /></div>);
  fireEvent.click(screen.getByRole("button",{name:"Share"}));
  const dialog=await screen.findByRole("dialog",{name:"Share app"});
  expect(within(dialog).getByRole("tablist",{name:"Sharing options"})).toBeTruthy();
  expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
  expect(Number(getComputedStyle(dialog).zIndex)).toBeGreaterThan(SHELL_Z_INDEX.fullscreenWindow);
  expect(Number(getComputedStyle(dialog).zIndex)).toBe(SHELL_Z_INDEX.appDialog);
});

for (const [surface, Component] of [["Web", AppSiteButton], ["Electron", DesktopAppSiteButton]] as const) {
  describe(`${surface} Share trigger`, () => {
    it("keeps visitor submissions reachable after the app is unpublished when it has forms", async () => {
      // Fault: gating submissions on a live site hides saved visitor responses once the owner unpublishes.
      fixture.client.get.mockResolvedValue(siteRecord({ status: "unpublished", forms: [rsvpForm] }) as never);
      render(<ContainedTrigger Component={Component} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Public/ }), { button: 0 });
      expect(await screen.findByRole("button", { name: "Visitor submissions" })).toBeTruthy();
    });

    it("hides visitor submissions for an app without forms", async () => {
      // Fault: an empty submissions section shown for apps that can never receive visitor responses.
      fixture.client.get.mockResolvedValue(siteRecord({ status: "published", forms: [] }) as never);
      render(<ContainedTrigger Component={Component} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await within(await screen.findByRole("dialog", { name: "Share app" })).findByText("Live");
      expect(screen.queryByRole("button", { name: "Visitor submissions" })).toBeNull();
    });

    it("stays accessible and toggles closed on the second pointer click, then supports Escape and reopen", async () => {
      render(<ContainedTrigger Component={Component} />);
      const trigger = screen.getByRole("button", { name: "Share" });
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "Share app" });
      expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
      expect(within(dialog).getByRole("heading", { name: "Share" })).toBeTruthy();
      // Without the email-invite preview flag, the retired one-time links leave no Private tab.
      expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Public"]);
      const panel = dialog.querySelector<HTMLElement>("section");
      expect(panel?.className).toContain("matrix-share");
      expect(dialog.className).not.toContain("bg-[#111113]");
      expect(dialog.getAttribute("data-side")).toBe("bottom");
      expect(dialog.getAttribute("data-align")).toBe("end");
      expect(dialog.style.width).toBe("min(22.5rem, var(--radix-popover-content-available-width))");
      expect(dialog.style.maxHeight).toBe("min(34rem, var(--radix-popover-content-available-height))");
      expect(dialog.className).toContain("overflow-hidden");
      expect(panel?.className).toContain("max-h-[inherit]");
      expect(document.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe("none");
      expect(screen.getByRole("button", { name: "Share", expanded: true })).toBe(trigger);
      // Exercise outside-pointer dismissal followed by click, not only click().
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(trigger);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(trigger.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(trigger);
      await screen.findByRole("dialog");
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      fireEvent.click(trigger);
      await screen.findByRole("dialog");
      if (surface === "Electron") {
        expect(fixture.acquire).toHaveBeenCalledTimes(3);
        expect(fixture.release).toHaveBeenCalledTimes(2);
      }
    });
    it("resets the visible app identity and releases the Electron overlay on unmount", async () => {
      const view = render(<ContainedTrigger Component={Component} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() => expect(fixture.client.get).toHaveBeenCalledWith("launch", expect.any(AbortSignal)));
      await act(async () => {});
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Public/ }), { button: 0 });
      fireEvent.click(screen.getByRole("button", { name: /Title & description/ }));
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved previous app" } });
      fixture.connection.runtimeSlot = "other"; fixture.connection.authGeneration += 1;
      view.rerender(<ContainedTrigger Component={Component} appSlug="other" />);
      await waitFor(() => expect(fixture.client.get).toHaveBeenCalledWith("other", expect.any(AbortSignal)));
      await act(async () => {});
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Public/ }), { button: 0 });
      fireEvent.click(screen.getByRole("button", { name: /Title & description/ }));
      expect(screen.getByLabelText("Title")).toHaveProperty("value", "Other");
      view.unmount();
      if (surface === "Electron") expect(fixture.release.mock.calls.length).toBe(fixture.acquire.mock.calls.length);
    });
  });
}
it("keeps the Electron trigger disabled without an authenticated API client", () => {
  fixture.connection.api = null;
  render(<DesktopAppSiteButton appSlug="launch" />);
  const trigger = screen.getByRole("button", { name: "Share" });
  expect(trigger).toHaveProperty("disabled", true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fixture.acquire).not.toHaveBeenCalled();
});
