// @vitest-environment jsdom

import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  isLoaded: true,
  isSignedIn: true,
  user: {
    fullName: null as string | null,
    username: "kongfupanda13",
    imageUrl: "",
    primaryEmailAddress: { emailAddress: "kongfupanda13@example.com" },
  },
  signOut: vi.fn(async () => undefined),
  openUserProfile: vi.fn(),
}));

const replaceMock = vi.hoisted(() => vi.fn());

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
    signOut: clerkState.signOut,
  }),
  useUser: () => ({
    user: clerkState.user,
  }),
  useClerk: () => ({
    signOut: clerkState.signOut,
    openUserProfile: clerkState.openUserProfile,
  }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("UserButton", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.useRealTimers();
    clerkState.isLoaded = true;
    clerkState.isSignedIn = true;
    clerkState.user.username = "kongfupanda13";
    clerkState.user.fullName = null;
    clerkState.signOut.mockResolvedValue(undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cleared: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    replaceMock.mockReset();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        origin: "http://localhost:3000",
        replace: replaceMock,
      },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function openAccountMenu() {
    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu for kongfupanda13" }), {
      button: 0,
      ctrlKey: false,
    });
    return screen.findByRole("menuitem", { name: "Sign out" });
  }

  it("renders the settings account control as a left-aligned row with the user's name", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    const trigger = screen.getByRole("button", { name: "Account menu for kongfupanda13" });
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("kongfupanda13");
    expect(screen.queryByText("Billing")).toBeNull();
  });

  it("renders the account menu on the shared popover layer", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");
    const { SHELL_Z_INDEX } = await import("../../shell/src/lib/shell-layering.js");

    render(<UserButton variant="settings" />);

    const signOutItem = await openAccountMenu();
    const menu = signOutItem.closest("[role='menu']");

    expect(menu).toBeTruthy();
    expect((menu as HTMLElement).style.zIndex).toBe(String(SHELL_Z_INDEX.popover));
  });

  it("clears the Matrix app session before signing out through Clerk", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    fireEvent.click(await openAccountMenu());

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/auth/app-session",
        expect.objectContaining({
          method: "DELETE",
          credentials: "include",
          signal: expect.any(AbortSignal),
        }),
      );
      expect(clerkState.signOut).toHaveBeenCalledWith({
        redirectUrl: "http://localhost:3000/sign-in",
      });
      expect(replaceMock).toHaveBeenCalledWith("http://localhost:3000/sign-in");
    });
  });

  it("logs non-OK Matrix app-session cleanup responses before Clerk sign-out", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Session unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    fireEvent.click(await openAccountMenu());

    await waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        "[auth] Matrix app session clear returned non-OK status",
        503,
      );
      expect(clerkState.signOut).toHaveBeenCalled();
    });
  });

  it("redirects after platform cleanup when Clerk sign-out does not settle", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    clerkState.signOut.mockImplementation(() => new Promise(() => {}));
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    const signOutItem = await openAccountMenu();
    vi.useFakeTimers();
    fireEvent.click(signOutItem);

    const pendingSignOutItem = screen.getByRole("menuitem", { name: "Signing out…" });
    expect(pendingSignOutItem.getAttribute("aria-disabled")).toBe("true");
    expect(pendingSignOutItem.getAttribute("aria-busy")).toBe("true");
    expect(pendingSignOutItem.querySelector("svg.animate-spin")).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(clerkState.signOut).toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(warnSpy).toHaveBeenCalledWith("[auth] Clerk sign-out timed out");
    expect(replaceMock).toHaveBeenCalledWith("http://localhost:3000/sign-in");
  });

  it("redirects after platform cleanup when Clerk sign-out rejects", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    clerkState.signOut.mockRejectedValue(new Error("boom"));
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    fireEvent.click(await openAccountMenu());

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "/api/auth/app-session",
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(errorSpy).toHaveBeenCalledWith("[auth] Clerk sign-out failed", "Error");
      expect(replaceMock).toHaveBeenCalledWith("http://localhost:3000/sign-in");
    });
  });
});
