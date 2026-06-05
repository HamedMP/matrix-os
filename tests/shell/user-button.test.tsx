// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({
    isLoaded: clerkState.isLoaded,
    isSignedIn: clerkState.isSignedIn,
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
    vi.restoreAllMocks();
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
  });

  it("renders the settings account control as a left-aligned row with the user's name", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    const trigger = screen.getByRole("button", { name: "Account menu for kongfupanda13" });
    expect(trigger).toBeTruthy();
    expect(trigger.textContent).toContain("kongfupanda13");
    expect(screen.queryByText("Billing")).toBeNull();
  });

  it("clears the Matrix app session before signing out through Clerk", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    fireEvent.pointerDown(screen.getByRole("button", { name: "Account menu for kongfupanda13" }), {
      button: 0,
      ctrlKey: false,
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

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
    });
  });
});
