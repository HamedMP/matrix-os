// @vitest-environment jsdom
import React, { type ComponentProps } from "react";
import { DesktopHelpMenu } from "@matrix-os/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebDesktopControls } from "@/components/desktop/WebDesktopControls";
vi.mock("@/components/UserButton", () => ({ UserButton: () => <button>Account</button> }));
vi.mock("@/components/onboarding/GettingStartedPopover", () => ({ GettingStartedPopover: ({ helpMenu, onOpenSettings, onOpenFirstWork }: ComponentProps<typeof import("@/components/onboarding/GettingStartedPopover").GettingStartedPopover>) => <DesktopHelpMenu {...helpMenu} incomplete gettingStarted={<button onClick={() => { onOpenSettings("integrations"); onOpenFirstWork(); }}>Getting started</button>} /> }));
const inventory = { items: [
 { handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] },
 { handle: "neo", runtimeSlot: "review", label: "Preview Computer", availability: "available", kind: "preview", gatewayPath: "/vm/neo?runtime=review", capabilities: [] },
], hasMore: false, limit: 20, selectedSlot: "primary" };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/api/auth/computers") ? inventory : url.includes("/api/system/info") ? { runtime: { runtimeSlot: "primary" } } : {} }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("shared Web Desktop top bar", () => {
 it("uses the installed preview identity and ignores late responses from the old computer", async () => {
  let finishOld: (value: unknown) => void = () => {};
  const pending = new Promise(resolve => { finishOld = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/api/auth/computers") ? inventory : url.includes("/vm/pr-2406/") ? { runtime: { runtimeSlot: "review" } } : url.includes("/api/system/info") ? pending : {} })));
  const props = { onOpenSettings: vi.fn(), onOpenCommandPalette: vi.fn(), onOpenSupport: vi.fn(), onOpenFirstWork: vi.fn() };
  const oldUrl = window.location.href;
  const view = render(<WebDesktopControls {...props} />);
  window.history.replaceState({}, "", "/vm/pr-2406");
  try {
   view.rerender(<WebDesktopControls {...props} />);
   await screen.findByRole("button", { name: "Change computer, currently Preview Computer" });
   await act(async () => { finishOld({ runtime: { runtimeSlot: "primary" } }); await pending; });
   expect(screen.queryByRole("button", { name: "Change computer, currently Main Computer" })).toBeNull();
   expect(screen.getByRole("button", { name: "Change computer, currently Preview Computer" })).toBeTruthy();
  } finally { window.history.replaceState({}, "", oldUrl); }
 });
 it("has Search, app/task Inbox, Help and a validated computer dropdown in the same order as Electron", async () => {
  const settings=vi.fn(), search=vi.fn(), support=vi.fn(), work=vi.fn();
  render(<WebDesktopControls onOpenSettings={settings} onOpenCommandPalette={search} onOpenSupport={support} onOpenFirstWork={work} />);
  const computer = await screen.findByRole("button", { name: "Change computer, currently Main Computer" });
  expect(screen.getAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Search", "Inbox", "Help", "Change computer, currently Main Computer", "Account"]);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));expect(search).toHaveBeenCalledOnce();
  fireEvent.pointerDown(computer, { button: 0, ctrlKey: false });
  const link=screen.getByRole("menuitem", { name: /Preview Computer/ });expect(link.getAttribute("href")).toBe("/vm/neo?runtime=review");
  fireEvent.keyDown(link, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Help" }));
  expect(screen.getByRole("link", { name: "Join Discord" }).getAttribute("href")).toBe("https://discord.gg/WHbvTG33w");
  fireEvent.click(screen.getByRole("button", { name: "Support chat" }));expect(support).toHaveBeenCalledOnce();
 });
 it("never offers navigation from an invalid computer inventory", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...inventory, items:[{...inventory.items[0],gatewayPath:"https://outside.example.com"}] }) })));
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Computer list unavailable" }), { button: 0, ctrlKey: false });
  expect(screen.queryByRole("menuitem", { name: /Main Computer/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh computers" })).toBeTruthy();
 });
});
