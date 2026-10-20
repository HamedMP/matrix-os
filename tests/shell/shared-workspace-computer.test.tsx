// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@matrix-os/ui", () => ({ DesktopTopBarActions: ({ computer }: { computer: React.ReactNode }) => <>{computer}</>, DesktopActivityInbox: () => null }));
vi.mock("@/components/UserButton", () => ({ UserButton: () => null }));
vi.mock("@/components/onboarding/GettingStartedPopover", () => ({ GettingStartedPopover: () => null }));
import { WebDesktopControls } from "../../shell/src/components/desktop/WebDesktopControls";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); window.history.replaceState({}, "", "/"); });
it("shows shared identity without loading personal inventory and retains personal access", async () => {
  window.history.replaceState({}, "", "/workspace");
  const fetcher = vi.fn().mockRejectedValue(new Error("Must not load personal inventory"));
  vi.stubGlobal("fetch", fetcher);
  render(<WebDesktopControls onOpenSettings={vi.fn()} onOpenCommandPalette={vi.fn()} onOpenSupport={vi.fn()} onOpenFirstWork={vi.fn()} />);
  const computer = screen.getByRole("button", { name: "Change computer, currently Shared workspace" });
  expect(computer.textContent).toContain("Shared workspace");
  fireEvent.pointerDown(computer, { button: 0, ctrlKey: false });
  expect(screen.getByRole("link", { name: "Personal computers" }).getAttribute("href")).toBe("/runtime");
  expect(fetcher).not.toHaveBeenCalled();
});
