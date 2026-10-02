// @vitest-environment jsdom

import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiState = vi.hoisted(() => ({
  get: vi.fn(),
  released: vi.fn(),
}));

vi.mock("@desktop/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: (platformHost: string) => (platformHost ? { get: apiState.get } : null),
  releaseDesktopCollaborationApi: apiState.released,
  closeDesktopCollaborationSessions: vi.fn(),
  collaborationRuntimeIdFromSystemInfo: vi.fn(() => null),
}));

import { useConnection } from "@desktop/renderer/src/stores/connection";
import { DesktopOrganizationMenuItems } from "@desktop/renderer/src/features/mission-control/DesktopOrganizationMenuItems";
import { DesktopDefaultOrganization } from "@desktop/renderer/src/features/collaboration/DesktopDefaultOrganization";

const KEY = "matrix.desktop.selectedOrganization:";

// Controlled open state the menu can actually change: a fixed `open` prop would pin it
// open whatever the item does, so the stays-open assertion could never fail.
function MenuHarness() {
  const [open, setOpen] = React.useState(true);
  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Portal>
        <DropdownMenu.Content>
          <DesktopOrganizationMenuItems itemClass="row" />
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function renderMenu() {
  return render(<MenuHarness />);
}

function signedInStatus(userId: string, extra: Record<string, unknown> = {}) {
  return {
    signedIn: true,
    handle: "nima",
    userId,
    platformHost: "https://app.matrix-os.com",
    runtimeSlot: "primary",
    authGeneration: 1,
    ...extra,
  };
}

function stubAuthStatus(status: unknown) {
  window.operator = {
    invoke: vi.fn(async (channel: string) => (channel === "auth:status" ? status : {})),
    on: vi.fn(),
  } as unknown as typeof window.operator;
}

beforeEach(() => {
  window.localStorage.clear();
  apiState.get.mockReset();
  apiState.released.mockReset();
  useConnection.setState({
    status: "signed-in",
    userId: "user_nima",
    organizationId: null,
    organizationStatus: "loading",
    platformHost: "https://app.matrix-os.com",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connection store organization selection", () => {
  it("remembers the chosen organization across an auth refresh", async () => {
    // The trusted-core status never carries an organization; without this every
    // share control on Electron Desktop remained in its loading state.
    useConnection.getState().selectOrganization("org_finna");
    stubAuthStatus(signedInStatus("user_nima"));

    await useConnection.getState().refresh();

    expect(useConnection.getState().organizationId).toBe("org_finna");
  });

  it("never applies one user's choice to the next account signed in", async () => {
    useConnection.getState().selectOrganization("org_finna");
    stubAuthStatus(signedInStatus("user_other"));

    await useConnection.getState().refresh();

    expect(useConnection.getState().organizationId).toBeNull();
  });

  it("prefers an organization the auth status does carry", async () => {
    useConnection.getState().selectOrganization("org_finna");
    stubAuthStatus(signedInStatus("user_nima", { organizationId: "org_status" }));

    await useConnection.getState().refresh();

    expect(useConnection.getState().organizationId).toBe("org_status");
  });

  it("refuses a malformed organization id", () => {
    useConnection.getState().selectOrganization("not-an-org");

    expect(useConnection.getState().organizationId).toBeNull();
    expect(window.localStorage.getItem(KEY + "user_nima")).toBeNull();
  });

  it("forgets the choice when cleared", () => {
    useConnection.getState().selectOrganization("org_finna");
    useConnection.getState().selectOrganization(null);

    expect(useConnection.getState().organizationId).toBeNull();
    expect(window.localStorage.getItem(KEY + "user_nima")).toBeNull();
  });
});

describe("DesktopOrganizationMenuItems", () => {
  it("lists the member's organizations and selects the one they choose", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_finna", name: "Finna" },
      { organizationId: "org_matrix", name: "Matrix" },
    ] });
    renderMenu();

    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Matrix" }));

    expect(apiState.get).toHaveBeenCalledWith("/api/organizations");
    expect(useConnection.getState().organizationId).toBe("org_matrix");
  });

  it("announces the active organization to assistive technology", async () => {
    useConnection.setState({ organizationId: "org_matrix" });
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_finna", name: "Finna" },
      { organizationId: "org_matrix", name: "Matrix" },
    ] });
    renderMenu();

    expect((await screen.findByRole("menuitemradio", { name: "Matrix" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Finna" }).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the menu open after a choice so the result is visible", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_finna", name: "Finna" },
      { organizationId: "org_matrix", name: "Matrix" },
    ] });
    renderMenu();

    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Matrix" }));

    expect(screen.getByRole("menuitemradio", { name: "Finna" })).toBeTruthy();
  });

  it("shows nothing for a member of no organization", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [] });
    renderMenu();

    await waitFor(() => expect(apiState.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByText("Organization")).toBeNull();
  });

  it("shows a failed load instead of rendering as if the member had no organizations", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiState.get.mockRejectedValue(new TypeError("network"));
    renderMenu();

    expect((await screen.findByRole("alert")).textContent).toBe("Couldn't load your organizations.");
    expect(screen.getByText("Organization")).toBeTruthy();
  });

  it("rejects a malformed listing instead of trusting it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiState.get.mockResolvedValue({ complete: true, organizations: [{ organizationId: "not-an-org", name: "Bad" }] });
    renderMenu();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "Bad" })).toBeNull();
  });

  it("moves a member off an organization they have since left, onto their oldest remaining one", async () => {
    useConnection.getState().selectOrganization("org_left");
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_matrix", name: "Matrix" },
      { organizationId: "org_finna", name: "Finna" },
    ] });
    renderMenu();

    await waitFor(() => expect(useConnection.getState().organizationId).toBe("org_finna"));
    expect(window.localStorage.getItem(KEY + "user_nima")).toBe("org_finna");
  });

  it("clears the organization of a member who has left every one", async () => {
    useConnection.getState().selectOrganization("org_left");
    apiState.get.mockResolvedValue({ complete: true, organizations: [] });
    renderMenu();

    await waitFor(() => expect(useConnection.getState().organizationId).toBeNull());
    expect(window.localStorage.getItem(KEY + "user_nima")).toBeNull();
  });

  it("never judges a newly signed-in user's choice against the previous user's list", async () => {
    apiState.get.mockResolvedValueOnce({ complete: true, organizations: [{ organizationId: "org_a", name: "A" }] });
    renderMenu();
    await screen.findByRole("menuitemradio", { name: "A" });

    // Account B signs in while the menu is open; B's own listing has not arrived yet.
    apiState.get.mockReturnValueOnce(new Promise(() => undefined));
    window.localStorage.setItem(KEY + "user_b", "org_b");
    act(() => { useConnection.setState({ userId: "user_b", organizationId: "org_b" }); });
    await act(async () => { await Promise.resolve(); });

    expect(useConnection.getState().organizationId).toBe("org_b");
    expect(window.localStorage.getItem(KEY + "user_b")).toBe("org_b");
  });

  it("keeps a remembered organization that a capped listing cannot rule out", async () => {
    useConnection.setState({ organizationId: "org_beyond_cap", organizationStatus: "loading" });
    const organizations = Array.from({ length: 100 }, (_, index) => ({
      organizationId: `org_${String(index).padStart(3, "0")}`,
      name: `Org ${index}`,
    }));
    apiState.get.mockResolvedValue({ complete: false, organizations });
    renderMenu();

    await screen.findByRole("menuitemradio", { name: "Org 0" });
    expect(useConnection.getState().organizationId).toBe("org_beyond_cap");
    expect(useConnection.getState().organizationStatus).toBe("unavailable");
  });

  it("treats an older platform response without completeness as non-authoritative", async () => {
    apiState.get.mockResolvedValue({ organizations: [{ organizationId: "org_finna", name: "Finna" }] });
    renderMenu();

    expect(await screen.findByRole("menuitemradio", { name: "Finna" })).toBeTruthy();
    expect(useConnection.getState().organizationId).toBe("org_finna");
    expect(useConnection.getState().organizationStatus).toBe("member");
  });

  it("releases its collaboration API once the menu has its listing", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [{ organizationId: "org_finna", name: "Finna" }] });
    const { unmount } = renderMenu();
    await screen.findByRole("menuitemradio", { name: "Finna" });

    unmount();

    expect(apiState.released).toHaveBeenCalledTimes(1);
  });
});

describe("connection store organization reconciliation", () => {
  it("ignores a listing read for a different account", () => {
    const { beginOrganizationListing, reconcileOrganizations } = useConnection.getState();
    reconcileOrganizations({ request: beginOrganizationListing(), forUserId: "user_other", organizationIds: ["org_finna"], complete: true });

    expect(useConnection.getState().organizationId).toBeNull();
  });

  it("keeps a choice a capped listing cannot rule out, but still offers a default from it", () => {
    const { beginOrganizationListing, reconcileOrganizations, selectOrganization } = useConnection.getState();
    reconcileOrganizations({ request: beginOrganizationListing(), forUserId: "user_nima", organizationIds: ["org_b", "org_a"], complete: false });
    expect(useConnection.getState().organizationId).toBe("org_a");

    selectOrganization("org_beyond_cap");
    // Model a persisted selection restored at sign-in but not yet verified in this
    // session; a partial listing cannot turn that stale local value into authority.
    useConnection.setState({ organizationStatus: "loading" });
    reconcileOrganizations({ request: beginOrganizationListing(), forUserId: "user_nima", organizationIds: ["org_b", "org_a"], complete: false });
    expect(useConnection.getState().organizationId).toBe("org_beyond_cap");
    expect(useConnection.getState().organizationStatus).toBe("unavailable");
  });

  it("keeps previously verified membership through a later listing failure", () => {
    const { beginOrganizationListing, reconcileOrganizations, organizationListingFailed } = useConnection.getState();
    reconcileOrganizations({
      request: beginOrganizationListing(),
      forUserId: "user_nima",
      organizationIds: ["org_finna"],
      complete: true,
    });

    organizationListingFailed({
      request: beginOrganizationListing(),
      forUserId: "user_nima",
    });

    expect(useConnection.getState().organizationId).toBe("org_finna");
    expect(useConnection.getState().organizationStatus).toBe("member");
  });

  it("keeps previously verified membership when an incomplete refresh omits it", () => {
    const { beginOrganizationListing, reconcileOrganizations } = useConnection.getState();
    reconcileOrganizations({
      request: beginOrganizationListing(),
      forUserId: "user_nima",
      organizationIds: ["org_finna"],
      complete: true,
    });

    reconcileOrganizations({
      request: beginOrganizationListing(),
      forUserId: "user_nima",
      organizationIds: [],
      complete: false,
    });

    expect(useConnection.getState().organizationId).toBe("org_finna");
    expect(useConnection.getState().organizationStatus).toBe("member");
  });
});

describe("DesktopDefaultOrganization", () => {
  it("never lets the sign-in listing undo a newer one from the account menu", async () => {
    useConnection.getState().selectOrganization("org_left");
    let resolveSignIn: (value: unknown) => void = () => undefined;
    apiState.get.mockReturnValueOnce(new Promise((resolve) => { resolveSignIn = resolve; }));
    render(<DesktopDefaultOrganization />);
    await waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(1));

    // The member opens the menu after leaving their only organization; that newer read lands first.
    apiState.get.mockResolvedValueOnce({ complete: true, organizations: [] });
    renderMenu();
    await waitFor(() => expect(useConnection.getState().organizationId).toBeNull());

    await act(async () => { resolveSignIn({ complete: true, organizations: [{ organizationId: "org_left", name: "Left" }] }); });

    expect(useConnection.getState().organizationId).toBeNull();
  });

  it("activates the oldest organization at sign-in without the member opening any menu", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_matrix", name: "Matrix" },
      { organizationId: "org_finna", name: "Finna" },
    ] });
    render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(useConnection.getState().organizationId).toBe("org_finna"));
    expect(apiState.get).toHaveBeenCalledWith("/api/organizations");
  });

  it("keeps an organization the member chose over the default", async () => {
    useConnection.getState().selectOrganization("org_matrix");
    apiState.get.mockResolvedValue({ complete: true, organizations: [
      { organizationId: "org_matrix", name: "Matrix" },
      { organizationId: "org_finna", name: "Finna" },
    ] });
    render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(apiState.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(useConnection.getState().organizationId).toBe("org_matrix");
  });

  it("keeps an individual user individual: no organization, nothing activated", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [] });
    render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(apiState.get).toHaveBeenCalled());
    await act(async () => { await Promise.resolve(); });
    expect(useConnection.getState().organizationId).toBeNull();
    expect(useConnection.getState().organizationStatus).toBe("none");
  });

  it("never applies one account's listing to the next account signed in", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    apiState.get.mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }));
    apiState.get.mockReturnValueOnce(new Promise(() => undefined));
    render(<DesktopDefaultOrganization />);
    await waitFor(() => expect(apiState.get).toHaveBeenCalledTimes(1));

    act(() => { useConnection.setState({ userId: "user_b", organizationId: null }); });
    await act(async () => { resolveFirst({ complete: true, organizations: [{ organizationId: "org_finna", name: "Finna" }] }); });

    expect(useConnection.getState().organizationId).toBeNull();
  });

  it("leaves sharing unavailable, not broken, when the listing cannot load", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    apiState.get.mockRejectedValue(new TypeError("network"));
    render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(useConnection.getState().organizationId).toBeNull();
    expect(useConnection.getState().organizationStatus).toBe("unavailable");
  });

  it("does not treat an incomplete empty projection as proof that the user has no organizations", async () => {
    apiState.get.mockResolvedValue({ complete: false, organizations: [] });
    render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(useConnection.getState().organizationStatus).toBe("unavailable"));
    expect(useConnection.getState().organizationId).toBeNull();
  });

  it("releases its collaboration API as soon as the listing settles, not at sign-out", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [] });
    const { unmount } = render(<DesktopDefaultOrganization />);

    await waitFor(() => expect(apiState.released).toHaveBeenCalledTimes(1));
    unmount();
    expect(apiState.released).toHaveBeenCalledTimes(1);
  });

  it("releases an API whose request is still in flight at sign-out", async () => {
    apiState.get.mockReturnValue(new Promise(() => undefined));
    const { unmount } = render(<DesktopDefaultOrganization />);
    await waitFor(() => expect(apiState.get).toHaveBeenCalled());
    expect(apiState.released).not.toHaveBeenCalled();

    unmount();

    expect(apiState.released).toHaveBeenCalledTimes(1);
  });
});
