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
  organization: null as { id: string } | null,
  organizationsLoaded: true,
  memberships: [] as Array<{ organization: { id: string; name: string } }>,
  setActive: vi.fn(async (_params: { organization: string }) => undefined),
  hasNextPage: false,
  isFetching: false,
  isError: false,
  fetchNext: vi.fn(),
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
  useOrganization: () => ({ organization: clerkState.organization }),
  useOrganizationList: () => ({
    isLoaded: clerkState.organizationsLoaded,
    setActive: clerkState.setActive,
    userMemberships: {
      data: clerkState.memberships,
      hasNextPage: clerkState.hasNextPage,
      isFetching: clerkState.isFetching,
      isError: clerkState.isError,
      fetchNext: clerkState.fetchNext,
    },
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
    clerkState.organization = null;
    clerkState.organizationsLoaded = true;
    clerkState.memberships = [];
    clerkState.setActive.mockReset();
    clerkState.setActive.mockResolvedValue(undefined);
    clerkState.hasNextPage = false;
    clerkState.isFetching = false;
    clerkState.isError = false;
    clerkState.fetchNext.mockReset();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ cleared: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    replaceMock.mockReset();
    delete document.documentElement.dataset.matrixSelfHosted;
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

  it("shows no organization section to a user who belongs to none", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("hides Shared with me when the membership list confirms no organizations", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");
    const { OrganizationStateProvider } = await import("../../shell/src/lib/collaboration-organization-state.js");

    render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
      <UserButton variant="dock" />
    </OrganizationStateProvider>);
    await openAccountMenu();

    expect(screen.queryByRole("menuitem", { name: "Shared with me" })).toBeNull();
  });

  it("shows no organization section until Clerk has loaded memberships", async () => {
    clerkState.organizationsLoaded = false;
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.queryByText("Organization")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: "Finna" })).toBeNull();
  });

  it("lists the member's organizations and activates the one they choose", async () => {
    // Sharing reads the *active* organization, and nothing else in the shell sets
    // one -- without this the share control stays in its loading state
    // for a user who already belongs to an organization.
    clerkState.memberships = [
      { organization: { id: "org_a", name: "Finna" } },
      { organization: { id: "org_b", name: "Matrix" } },
    ];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.getByText("Organization")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Matrix" }));
    expect(clerkState.setActive).toHaveBeenCalledWith({ organization: "org_b" });
  });

  it("keeps the menu open after a choice so the result is visible where it was made", async () => {
    clerkState.memberships = [
      { organization: { id: "org_a", name: "Finna" } },
      { organization: { id: "org_b", name: "Matrix" } },
    ];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Matrix" }));

    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalled());
    expect(screen.getByRole("menuitemradio", { name: "Finna" })).toBeTruthy();
  });

  it("does not re-activate the organization that is already active", async () => {
    clerkState.organization = { id: "org_a" };
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Finna" }));

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("announces the active organization to assistive technology, not only with a checkmark", async () => {
    clerkState.organization = { id: "org_b" };
    clerkState.memberships = [
      { organization: { id: "org_a", name: "Finna" } },
      { organization: { id: "org_b", name: "Matrix" } },
    ];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.getByRole("menuitemradio", { name: "Matrix" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Finna" }).getAttribute("aria-checked")).toBe("false");
  });

  it("shows a visible failure instead of only logging when activation fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clerkState.setActive.mockRejectedValue(new TypeError("network"));
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Finna" }));

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't switch to Finna. Try again.");
    expect(warn).toHaveBeenCalledWith("[collaboration-organization] activation failed", "TypeError");
  });

  it("offers later pages of memberships instead of silently dropping them", async () => {
    clerkState.hasNextPage = true;
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "More organizations" }));

    expect(clerkState.fetchNext).toHaveBeenCalledTimes(1);
  });

  it("shows a failed page load and keeps the next-page item available to retry", async () => {
    clerkState.isError = true;
    clerkState.hasNextPage = true;
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.getByRole("alert").textContent).toBe("Couldn't load more organizations. Try again.");
    fireEvent.click(screen.getByRole("menuitem", { name: "More organizations" }));
    expect(clerkState.fetchNext).toHaveBeenCalledTimes(1);
  });

  it("shows a failed first load instead of rendering as if the member had no organizations", async () => {
    clerkState.isError = true;
    clerkState.memberships = [];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.getByText("Organization")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load your organizations.");
  });

  it("offers no further page once every membership is loaded", async () => {
    clerkState.memberships = [{ organization: { id: "org_a", name: "Finna" } }];
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.queryByRole("menuitem", { name: "More organizations" })).toBeNull();
  });

  it("offers hosted users both computer-management actions", async () => {
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);
    await openAccountMenu();

    expect(screen.getByRole("menuitem", { name: "Switch computer" }).getAttribute("href")).toBe("/runtime");
    expect(screen.getByRole("menuitem", { name: "Get another computer" }).getAttribute("href")).toBe("/?billing=setup&handoff=add-computer");
  });

  it("preserves desktop account Help and Billing navigation", async () => {
    const onOpenSettings = vi.fn();
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="menubar" onOpenSettings={onOpenSettings} />);
    await openAccountMenu();

    const help = screen.getByRole("menuitem", { name: "Get help" });
    expect(help.getAttribute("href")).toBe("https://matrix-os.com/docs");
    expect(help.getAttribute("target")).toBe("_blank");
    fireEvent.click(screen.getByRole("menuitem", { name: "View plans" }));
    expect(onOpenSettings).toHaveBeenCalledWith("billing");
  });

  it("excludes hosted computer actions in self-hosted mode", async () => {
    document.documentElement.dataset.matrixSelfHosted = "1";
    const { UserButton } = await import("../../shell/src/components/UserButton.js");

    render(<UserButton variant="settings" />);

    expect(screen.getByRole("button", { name: "Self-hosted Matrix OS" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Switch computer" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Get another computer" })).toBeNull();
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
