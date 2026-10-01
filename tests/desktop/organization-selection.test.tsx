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
    platformHost: "https://app.matrix-os.com",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("connection store organization selection", () => {
  it("remembers the chosen organization across an auth refresh", async () => {
    // The trusted-core status never carries an organization; without this every
    // share control on Electron Desktop read "Join an organization to share".
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
    apiState.get.mockResolvedValue({ organizations: [
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
    apiState.get.mockResolvedValue({ organizations: [
      { organizationId: "org_finna", name: "Finna" },
      { organizationId: "org_matrix", name: "Matrix" },
    ] });
    renderMenu();

    expect((await screen.findByRole("menuitemradio", { name: "Matrix" })).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menuitemradio", { name: "Finna" }).getAttribute("aria-checked")).toBe("false");
  });

  it("keeps the menu open after a choice so the result is visible", async () => {
    apiState.get.mockResolvedValue({ organizations: [
      { organizationId: "org_finna", name: "Finna" },
      { organizationId: "org_matrix", name: "Matrix" },
    ] });
    renderMenu();

    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Matrix" }));

    expect(screen.getByRole("menuitemradio", { name: "Finna" })).toBeTruthy();
  });

  it("shows nothing for a member of no organization", async () => {
    apiState.get.mockResolvedValue({ organizations: [] });
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
    apiState.get.mockResolvedValue({ organizations: [{ organizationId: "not-an-org", name: "Bad" }] });
    renderMenu();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByRole("menuitemradio", { name: "Bad" })).toBeNull();
  });

  it("clears a remembered organization the member has since left", async () => {
    useConnection.getState().selectOrganization("org_left");
    apiState.get.mockResolvedValue({ organizations: [{ organizationId: "org_finna", name: "Finna" }] });
    renderMenu();

    await waitFor(() => expect(useConnection.getState().organizationId).toBeNull());
    expect(window.localStorage.getItem(KEY + "user_nima")).toBeNull();
  });

  it("never judges a newly signed-in user's choice against the previous user's list", async () => {
    apiState.get.mockResolvedValueOnce({ organizations: [{ organizationId: "org_a", name: "A" }] });
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
    useConnection.getState().selectOrganization("org_beyond_cap");
    const organizations = Array.from({ length: 100 }, (_, index) => ({
      organizationId: `org_${String(index).padStart(3, "0")}`,
      name: `Org ${index}`,
    }));
    apiState.get.mockResolvedValue({ organizations });
    renderMenu();

    await screen.findByRole("menuitemradio", { name: "Org 0" });
    expect(useConnection.getState().organizationId).toBe("org_beyond_cap");
  });

  it("releases its collaboration API when the menu closes", async () => {
    apiState.get.mockResolvedValue({ organizations: [{ organizationId: "org_finna", name: "Finna" }] });
    const { unmount } = renderMenu();
    await screen.findByRole("menuitemradio", { name: "Finna" });

    unmount();

    expect(apiState.released).toHaveBeenCalledTimes(1);
  });
});
