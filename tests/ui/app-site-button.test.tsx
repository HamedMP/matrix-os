// @vitest-environment jsdom
import React, { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSiteButton } from "../../shell/src/components/app-sites/AppSiteButton";
import { AppSiteOwnerIdentityProvider } from "../../shell/src/components/app-sites/AppSiteOwnerIdentity";
import { DesktopAppSiteButton } from "../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";

const fixture = vi.hoisted(() => {
  const client = { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null) };
  const connection = { api: {} as object | null, runtimeSlot: "primary", authGeneration: 0, email: "owner@example.com" as string | null, userId: "user_owner" as string | null };
  return { client, connection, acquire: vi.fn(), release: vi.fn() };
});
vi.mock("../../shell/src/components/app-sites/web-site-client", () => ({ webSiteClient: fixture.client }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => fixture.client }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (state: typeof fixture.connection) => unknown) => select(fixture.connection) }));
vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({ useUi: (select: (state: { acquireRendererOverlay: () => void; releaseRendererOverlay: () => void }) => unknown) => select({ acquireRendererOverlay: fixture.acquire, releaseRendererOverlay: fixture.release }) }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.connection.api = {}; fixture.connection.runtimeSlot = "primary"; fixture.connection.authGeneration = 0;
  fixture.connection.email = "owner@example.com"; fixture.connection.userId = "user_owner";
});
afterEach(cleanup);

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
  fireEvent.click(screen.getByRole("button",{name:"Publish app"}));
  const dialog=await screen.findByRole("dialog",{name:"Share app"});
  expect(within(dialog).getByText("Create a one-time invite link, or publish at a stable URL.")).toBeTruthy();
  expect(within(dialog).queryByText("Create a one-time invite link, or publish the app at a stable URL.")).toBeNull();
  expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
  expect(Number(getComputedStyle(dialog).zIndex)).toBeGreaterThan(SHELL_Z_INDEX.fullscreenWindow);
  expect(Number(getComputedStyle(dialog).zIndex)).toBe(SHELL_Z_INDEX.appDialog);
});

for (const [surface, Component] of [["Web", AppSiteButton], ["Electron", DesktopAppSiteButton]] as const) {
  describe(`${surface} Publish app trigger`, () => {
    it("stays accessible and toggles closed on the second pointer click, then supports Escape and reopen", async () => {
      render(<ContainedTrigger Component={Component} />);
      const trigger = screen.getByRole("button", { name: "Publish app" });
      fireEvent.click(trigger);
      const dialog = await screen.findByRole("dialog", { name: "Share app" });
      expect(screen.getByTestId("created-app-surface").contains(dialog)).toBe(true);
      expect(screen.getByRole("heading", { name: "Invite" })).toBeTruthy();
      expect(screen.getByText("You (owner@example.com)")).toBeTruthy();
      const panel = dialog.querySelector<HTMLElement>("section");
      expect(panel?.style.background).toContain("var(");
      expect(panel?.style.background).not.toContain("#111113");
      expect(dialog.className).not.toContain("bg-[#111113]");
      expect(dialog.getAttribute("data-side")).toBe("bottom");
      expect(dialog.getAttribute("data-align")).toBe("end");
      expect(dialog.style.width).toBe("min(24rem, var(--radix-popover-content-available-width))");
      expect(dialog.style.maxHeight).toBe("min(34rem, var(--radix-popover-content-available-height))");
      expect(dialog.className).toContain("overflow-hidden");
      expect(panel?.style.maxHeight).toBe("inherit");
      expect(document.querySelector("[data-slot='dialog-overlay']")).toBeNull();
      expect(document.body.style.pointerEvents).not.toBe("none");
      expect(screen.getByRole("button", { name: "Publish app", expanded: true })).toBe(trigger);
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
      fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
      await waitFor(() => expect(fixture.client.get).toHaveBeenCalledTimes(1));
      await act(async () => {});
      fireEvent.click(await screen.findByRole("button", { name: /Publish app to a permanent URL/ }));
      await screen.findByText("This app is private.");
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved previous app" } });
      fixture.connection.runtimeSlot = "other"; fixture.connection.authGeneration += 1;
      view.rerender(<ContainedTrigger Component={Component} appSlug="other" />);
      await waitFor(() => expect(fixture.client.get).toHaveBeenCalledTimes(2));
      await act(async () => {});
      fireEvent.click(await screen.findByRole("button", { name: /Publish app to a permanent URL/ }));
      await screen.findByText("This app is private.");
      expect(screen.getByLabelText("Title")).toHaveProperty("value", "other");
      view.unmount();
      if (surface === "Electron") expect(fixture.release.mock.calls.length).toBe(fixture.acquire.mock.calls.length);
    });
  });
}
it("keeps the Electron trigger disabled without an authenticated API client", () => {
  fixture.connection.api = null;
  render(<DesktopAppSiteButton appSlug="launch" />);
  const trigger = screen.getByRole("button", { name: "Publish app" });
  expect(trigger).toHaveProperty("disabled", true);
  fireEvent.click(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fixture.acquire).not.toHaveBeenCalled();
});
it("uses the Electron user ID when the account has no email", async () => {
  fixture.connection.email = null;
  fixture.connection.userId = "user_fallback";
  render(<ContainedTrigger Component={DesktopAppSiteButton} />);
  fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
  expect(await screen.findByText("You (user_fallback)")).toBeTruthy();
});
