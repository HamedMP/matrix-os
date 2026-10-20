// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppSiteButton } from "../../shell/src/components/app-sites/AppSiteButton";
import { DesktopAppSiteButton } from "../../desktop/src/renderer/src/features/app-sites/DesktopAppSiteButton";
import { SHELL_Z_INDEX } from "../../shell/src/lib/shell-layering";

const fixture = vi.hoisted(() => {
  const client = { getConfig: vi.fn(async () => ({ data: {}, forms: [] })), get: vi.fn(async () => null) };
  const connection = { api: {} as object | null, runtimeSlot: "primary", authGeneration: 0 };
  return { client, connection, acquire: vi.fn(), release: vi.fn() };
});
vi.mock("../../shell/src/components/app-sites/web-site-client", () => ({ webSiteClient: fixture.client }));
vi.mock("../../desktop/src/renderer/src/features/app-sites/site-client", () => ({ createDesktopSiteClient: () => fixture.client }));
vi.mock("../../desktop/src/renderer/src/stores/connection", () => ({ useConnection: (select: (state: typeof fixture.connection) => unknown) => select(fixture.connection) }));
vi.mock("../../desktop/src/renderer/src/stores/ui", () => ({ useUi: (select: (state: { acquireRendererOverlay: () => void; releaseRendererOverlay: () => void }) => unknown) => select({ acquireRendererOverlay: fixture.acquire, releaseRendererOverlay: fixture.release }) }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.connection.api = {}; fixture.connection.runtimeSlot = "primary"; fixture.connection.authGeneration = 0;
});
afterEach(cleanup);

it("keeps Web publishing above a maximized app window", async () => {
  render(<div style={{ position:"fixed",zIndex:SHELL_Z_INDEX.fullscreenWindow }}><AppSiteButton appSlug="launch" /></div>);
  fireEvent.click(screen.getByRole("button",{name:"Publish app"}));
  const dialog=await screen.findByRole("dialog",{name:"Publish app"});
  expect(Number(getComputedStyle(dialog).zIndex)).toBeGreaterThan(SHELL_Z_INDEX.fullscreenWindow);
  expect(Number(getComputedStyle(dialog).zIndex)).toBe(SHELL_Z_INDEX.appDialog);
});

for (const [surface, Component] of [["Web", AppSiteButton], ["Electron", DesktopAppSiteButton]] as const) {
  describe(`${surface} Publish app trigger`, () => {
    it("stays accessible and toggles closed on the second pointer click, then supports Escape and reopen", async () => {
      render(<Component appSlug="launch" />);
      const trigger = screen.getByRole("button", { name: "Publish app" });
      fireEvent.click(trigger);
      await screen.findByRole("dialog", { name: "Publish app" });
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
      const view = render(<Component appSlug="launch" />);
      fireEvent.click(screen.getByRole("button", { name: "Publish app" }));
      await screen.findByText("This app is private.");
      fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Unsaved previous app" } });
      fixture.connection.runtimeSlot = "other"; fixture.connection.authGeneration += 1;
      view.rerender(<Component appSlug="other" />);
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
