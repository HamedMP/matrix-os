// @vitest-environment jsdom
import React, { type ComponentProps } from "react";
import { GettingStartedPill } from "@matrix-os/ui";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebDesktopControls } from "@/components/desktop/WebDesktopControls";
vi.mock("@/components/UserButton", () => ({ UserButton: () => <button>Account</button> }));
vi.mock("@/components/onboarding/GettingStartedPopover", () => ({ GettingStartedPopover: ({ onOpenSettings, onOpenFirstWork }: ComponentProps<typeof import("@/components/onboarding/GettingStartedPopover").GettingStartedPopover>) => <GettingStartedPill completed={4} total={5} onClick={() => { onOpenSettings("integrations"); onOpenFirstWork(); }} /> }));
const inventory = { items: [
 { handle: "neo", runtimeSlot: "primary", label: "Main Computer", availability: "available", kind: "customer", gatewayPath: "/vm/neo", capabilities: [] },
 { handle: "neo", runtimeSlot: "review", label: "Preview Computer", availability: "available", kind: "preview", gatewayPath: "/vm/neo?runtime=review", capabilities: [] },
], hasMore: false, limit: 20, selectedSlot: "primary" };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () => url.includes("/api/auth/computers") ? inventory : url.includes("/api/system/info") ? { runtime: { runtimeSlot: "primary" } } : {} }))));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("shared Web Desktop top bar", () => {
 it("reloads the computer menu when Settings changes an owned computer", async () => {
  const { announceComputersChanged } = await import("@/lib/computers-changed");
  const props = { onOpenSettings: vi.fn(), onOpenCommandPalette: vi.fn(), onOpenSupport: vi.fn(), onOpenFirstWork: vi.fn() };
  render(<WebDesktopControls {...props} />);
  await screen.findByRole("button", { name: "Change computer, currently Main Computer" });
  const fetchMock = vi.mocked(fetch);
  const before = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/auth/computers")).length;
  await act(async () => { announceComputersChanged(); });
  await screen.findByRole("button", { name: "Change computer, currently Main Computer" });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/auth/computers")).length).toBe(before + 1);
 });
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
 it("leads with the Setup pill, has no Help button and opens Support directly", async () => {
  const settings=vi.fn(), search=vi.fn(), support=vi.fn(), work=vi.fn();
  render(<WebDesktopControls onOpenSettings={settings} onOpenCommandPalette={search} onOpenSupport={support} onOpenFirstWork={work} />);
  const computer = await screen.findByRole("button", { name: "Change computer, currently Main Computer" });
  expect(screen.getAllByRole("button").map(b => b.getAttribute("aria-label") ?? b.textContent)).toEqual(["Getting started — 4 of 5", "Search", "Inbox", "Support", "Change computer, currently Main Computer", "Account"]);
  expect(screen.queryByRole("button", { name: "Help" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));expect(search).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Support", exact: true }));expect(support).toHaveBeenCalledOnce();
  fireEvent.pointerDown(computer, { button: 0, ctrlKey: false });
  const link=screen.getByRole("menuitem", { name: /Preview Computer/ });expect(link.getAttribute("href")).toBe("/vm/neo?runtime=review");
  fireEvent.keyDown(link, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Getting started — 4 of 5" }));
  expect(settings).toHaveBeenCalledWith("integrations"); expect(work).toHaveBeenCalledOnce();
 });
 it("retains validated choices and All computers when the installed slot is outside the bounded list", async () => {
  const bounded = { ...inventory, items: [inventory.items[0]], hasMore: true };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, json: async () =>
    url.includes("/api/auth/computers") ? bounded : url.includes("/api/system/info") ? { runtime: { runtimeSlot: "review" } } : {} })));
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  const trigger = await screen.findByRole("button", { name: "Change computer, currently Current computer" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  expect(screen.getByRole("menuitem", { name: /Main Computer/ }).getAttribute("href")).toBe(inventory.items[0].gatewayPath);
  expect(screen.getByRole("link", { name: "All computers" }).getAttribute("href")).toBe("/runtime");
  expect(screen.queryByText(/Current · neo/)).toBeNull();
 });
 it("never offers navigation from an invalid computer inventory", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ ...inventory, items:[{...inventory.items[0],gatewayPath:"https://outside.example.com"}] }) })));
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  fireEvent.pointerDown(await screen.findByRole("button", { name: "Computer list unavailable" }), { button: 0, ctrlKey: false });
  expect(screen.queryByRole("menuitem", { name: /Main Computer/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Refresh computers" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "All computers" }).getAttribute("href")).toBe("/runtime");
 });
});
