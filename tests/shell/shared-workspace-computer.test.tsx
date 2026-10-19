// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@matrix-os/ui", () => ({ DesktopTopBarActions: ({ computer }: { computer: React.ReactNode }) => <>{computer}</>, DesktopActivityInbox: () => null }));
vi.mock("@/components/UserButton", () => ({ UserButton: () => null }));
vi.mock("@/components/onboarding/GettingStartedPopover", () => ({ GettingStartedPopover: () => null }));
import { WebDesktopControls } from "../../shell/src/components/desktop/WebDesktopControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
it("retains shared identity and personal access if platform inventory is unavailable", async () => {
  window.history.replaceState({}, "", "/workspace");
  const fetcher = vi.fn().mockRejectedValue(new Error("Must not load personal inventory"));
  vi.stubGlobal("fetch", fetcher);
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  const computer = screen.getByRole("button", { name: "Change computer, currently Shared workspace" });
  expect(computer.textContent).toContain("Shared workspace");
  fireEvent.pointerDown(computer, { button: 0, ctrlKey: false });
  expect(screen.getByRole("link", { name: "Personal computers" }).getAttribute("href")).toBe("/runtime");
  expect(fetcher).toHaveBeenCalledWith('/api/auth/computers?include=starter', expect.any(Object));
});

it('shows Starter as a separate computer and links back to the unchanged personal VPS', async () => {
  window.history.replaceState({}, '', '/workspace');
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [
    { handle: 'hamed', runtimeSlot: 'primary', label: 'Main Computer', availability: 'available', kind: 'customer', gatewayPath: '/vm/hamed', capabilities: [] },
    { handle: 'hamed', runtimeSlot: 'starter', label: 'Starter Computer', availability: 'available', kind: 'starter', gatewayPath: '/workspace', capabilities: ['starterComputerWebV1'] },
  ], selectedSlot: 'primary', hasMore: false, limit: 20 }) });
  vi.stubGlobal('fetch', fetcher);
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  const computer = await screen.findByRole('button', { name: 'Change computer, currently Starter Computer' });
  fireEvent.pointerDown(computer, { button: 0, ctrlKey: false });
  expect(screen.getByRole('menuitem', { name: /Main Computer/ }).getAttribute('href')).toBe('/vm/hamed');
  expect(screen.getByRole('menuitem', { name: /Starter Computer/ }).getAttribute('data-disabled')).not.toBeNull();
  expect(fetcher).toHaveBeenCalledOnce();
});

it('keeps a personal computer named starter selectable from the shared workspace', async () => {
  window.history.replaceState({}, '', '/workspace');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [
    { handle: 'hamed', runtimeSlot: 'starter', label: 'Additional Computer', availability: 'available', kind: 'customer', gatewayPath: '/vm/hamed?runtime=starter', capabilities: [] },
  ], selectedSlot: 'starter', hasMore: false, limit: 20 }) }));
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Change computer, currently Shared workspace' }), { button: 0, ctrlKey: false });
  const personal = await screen.findByRole('menuitem', { name: /Additional Computer/ });
  expect(personal.getAttribute('href')).toBe('/vm/hamed?runtime=starter');
  expect(personal.getAttribute('data-disabled')).toBeNull();
  fireEvent.keyDown(personal, { key: 'Escape' });
  expect(screen.getByRole('button', { name: 'Change computer, currently Shared workspace' })).toBeTruthy();
});
