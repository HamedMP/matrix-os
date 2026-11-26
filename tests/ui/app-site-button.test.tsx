// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSiteButton } from "../../shell/src/components/app-sites/AppSiteButton";
import { AppSiteOwnerIdentityProvider } from "../../shell/src/components/app-sites/AppSiteOwnerIdentity";
import { DesktopAppSiteButton } from "../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";

const fixture = vi.hoisted(() => {
  const client = { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null), submissions: vi.fn(async () => ({ submissions: [] as unknown[], nextCursor: null })), slugAvailability: vi.fn(async () => ({ status: "available", suggestions: [] })), deploy: vi.fn(), update: vi.fn(), unpublish: vi.fn() };
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
  fixture.client.submissions.mockImplementation(async () => ({ submissions: [], nextCursor: null }));
  fixture.connection.api = { forRuntime: () => null }; fixture.connection.runtimeSlot = "primary"; fixture.connection.authGeneration = 0;
  fixture.connection.email = "owner@example.com"; fixture.connection.userId = "user_owner";
});
afterEach(cleanup);

const rsvpForm = { id: "rsvp", title: "RSVP", fields: { email: { type: "email", required: true } } };
const savedResponse = { id: "55555555-5555-4555-8555-555555555555", siteId: "11111111-1111-4111-8111-111111111111", formId: "rsvp", fields: { email: "ada@example.com" }, createdAt: "2026-11-01T10:00:00.000Z" };
function siteRecord({ status, forms, appSlug = "launch" }: { status: "published" | "unpublished"; forms: unknown[]; appSlug?: string }) {
  const siteId = "11111111-1111-4111-8111-111111111111";
  return { id: siteId, appSlug, title: "Launch", description: "", slug: null, url: `https://matrix.page/${siteId}`, revision: 4, status, accessMode: "public", activeVersion: null, versions: [], config: { data: {}, forms } };
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

    it("keeps saved visitor responses reachable after an update removes the app's forms", async () => {
      // Fault: gating on declared forms alone strands responses saved by an earlier version.
      fixture.client.get.mockResolvedValue(siteRecord({ status: "published", forms: [] }) as never);
      fixture.client.submissions.mockResolvedValue({ submissions: [savedResponse], nextCursor: null });
      render(<ContainedTrigger Component={Component} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      fireEvent.mouseDown(await screen.findByRole("tab", { name: /Public/ }), { button: 0 });
      expect(await screen.findByRole("button", { name: "Visitor submissions" })).toBeTruthy();
    });

    it("hides visitor submissions for an app without forms or saved responses", async () => {
      // Fault: an empty submissions section shown for apps that can never receive visitor responses.
      fixture.client.get.mockResolvedValue(siteRecord({ status: "published", forms: [] }) as never);
      render(<ContainedTrigger Component={Component} />);
      fireEvent.click(screen.getByRole("button", { name: "Share" }));
      await within(await screen.findByRole("dialog", { name: "Share app" })).findByText(/^Live\b/);
      await waitFor(() => expect(fixture.client.submissions).toHaveBeenCalled());
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
    // Default apps (Calculator, Notes, games) never start sharing, but an owner who
    // published one earlier must still be able to take the live link down.
    it("shows no Share on a default app that is not shared", async () => {
      // Fault: a default app offering Publish like an app the owner built.
      render(<ContainedTrigger Component={Component} appSlug="calculator" />);
      await waitFor(() => expect(fixture.client.get).toHaveBeenCalledWith("calculator", expect.any(AbortSignal)));
      await act(async () => {});
      expect(screen.queryByRole("button", { name: "Share" })).toBeNull();
    });

    it("lets the owner only unpublish a default app that is already live", async () => {
      // Fault: hiding Share on default apps strands an earlier Calculator link with no way to unpublish it.
      const live = siteRecord({ status: "published", forms: [], appSlug: "calculator" });
      fixture.client.get.mockResolvedValue(live as never);
      fixture.client.unpublish.mockImplementation(async () => {
        fixture.client.get.mockResolvedValue({ ...live, status: "unpublished", revision: 5 } as never);
        return { ...live, status: "unpublished", revision: 5 };
      });
      render(<ContainedTrigger Component={Component} appSlug="calculator" />);
      fireEvent.click(await screen.findByRole("button", { name: "Live" }));
      const dialog = await screen.findByRole("dialog", { name: "Share app" });
      await within(dialog).findByText(/^Live\b/);
      expect(within(dialog).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Public"]);
      expect(within(dialog).queryByRole("button", { name: /Update/ })).toBeNull();
      expect(within(dialog).queryByRole("button", { name: "Edit details" })).toBeNull();
      fireEvent.click(within(dialog).getByRole("button", { name: "Unpublish" }));
      await waitFor(() => expect(fixture.client.unpublish).toHaveBeenCalledWith("calculator", 4, expect.any(AbortSignal)));
      // Nothing is shared any more, so the default app loses its Share entry.
      await waitFor(() => expect(screen.queryByRole("button", { name: /Live|Share/ })).toBeNull());
      expect(fixture.client.deploy).not.toHaveBeenCalled();
      if (surface === "Electron") await waitFor(() => expect(fixture.release.mock.calls.length).toBe(fixture.acquire.mock.calls.length));
    });

    it("keeps Share and Retry on a default app whose sharing state could not be read", async () => {
      // Fault: a failed first read hides Share on a live Calculator, leaving no Retry and no Unpublish.
      const live = siteRecord({ status: "published", forms: [], appSlug: "calculator" });
      // Fails the first read and the re-read on open; recovers for Retry.
      const offline = Object.assign(new Error("offline"), { status: 503 });
      fixture.client.get.mockRejectedValueOnce(offline).mockRejectedValueOnce(offline);
      fixture.client.get.mockResolvedValue(live as never);
      render(<ContainedTrigger Component={Component} appSlug="calculator" />);
      fireEvent.click(await screen.findByRole("button", { name: "Share" }));
      const dialog = await screen.findByRole("dialog", { name: "Share app" });
      expect(within(dialog).queryByRole("button", { name: /^Publish$/ })).toBeNull();
      fireEvent.click(await within(dialog).findByRole("button", { name: "Retry" }));
      // The popover stays open through the retry and lands on the live publication.
      expect(await within(screen.getByRole("dialog", { name: "Share app" })).findByRole("button", { name: "Unpublish" })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Live" })).toBeTruthy();
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
