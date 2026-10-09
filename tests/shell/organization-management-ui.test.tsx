// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DropdownMenu as DropdownMenuPrimitive } from "radix-ui";
import type {
  OrganizationManagementInvitation,
  OrganizationManagementMember,
  OrganizationManagementSummary,
} from "@matrix-os/contracts";

const clerkState = vi.hoisted(() => ({
  userId: "user_nima" as string | null,
  organization: { id: "org_northwind" } as { id: string } | null,
  setActive: vi.fn(async (_input: { organization: string | null }) => undefined),
}));
const apiState = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), release: vi.fn() }));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: clerkState.userId }),
  useOrganization: () => ({ organization: clerkState.organization }),
  useOrganizationList: () => ({ isLoaded: true, setActive: clerkState.setActive }),
}));
vi.mock("@/hooks/useBrowserOrigin", () => ({ useBrowserOrigin: () => "https://app.matrix-os.com" }));
vi.mock("@/lib/collaboration", () => ({
  createShellCollaborationApi: () => ({ get: apiState.get, post: apiState.post, patch: apiState.patch, delete: apiState.delete }),
  releaseShellCollaborationApi: apiState.release,
}));

import {
  OrganizationSwitcher,
  OrganizationSwitcherView,
} from "../../shell/src/components/organization/OrganizationSwitcher";
import OrganizationSection, {
  OrganizationSectionView,
} from "../../shell/src/components/settings/sections/OrganizationSection";
import { InviteMembersDialog } from "../../shell/src/components/organization/OrganizationDialogs";
import { readOrganizationSelection } from "../../shell/src/lib/organization-selection";

const northwind: OrganizationManagementSummary = {
  organizationId: "org_northwind",
  name: "Northwind",
  slug: "northwind",
  role: "org:admin",
  memberCount: 4,
  aiSubmission: "members",
  membershipEpoch: 3,
};
const acme: OrganizationManagementSummary = {
  ...northwind,
  organizationId: "org_acme",
  name: "Acme Studio",
  slug: "acme-studio",
  role: "org:member",
  memberCount: 8,
};
const members: OrganizationManagementMember[] = [
  { actorId: "user_nima", displayName: "Nima Boscarino", emailAddress: "nima@example.com", role: "org:admin", joinedAt: "2026-10-01T10:00:00.000Z" },
  { actorId: "user_ava", displayName: "Ava Chen", emailAddress: "ava@example.com", role: "org:member", joinedAt: "2026-10-02T10:00:00.000Z" },
];
const invitations: OrganizationManagementInvitation[] = [{
  invitationId: "orginv_pending",
  emailAddress: "sam@example.com",
  role: "org:member",
  createdAt: "2026-10-03T10:00:00.000Z",
  expiresAt: "2026-10-10T10:00:00.000Z",
}];

beforeEach(() => {
  window.localStorage.clear();
  clerkState.userId = "user_nima";
  clerkState.organization = { id: "org_northwind" };
  clerkState.setActive.mockReset();
  clerkState.setActive.mockResolvedValue(undefined);
  apiState.get.mockReset();
  apiState.post.mockReset();
  apiState.patch.mockReset();
  apiState.delete.mockReset();
  apiState.release.mockReset();
});
afterEach(cleanup);

function renderSwitcher(organization: OrganizationManagementSummary = northwind) {
  const onSelect = vi.fn();
  const onOpenSettings = vi.fn();
  const onOpenInvite = vi.fn();
  render(
    <DropdownMenuPrimitive.Root defaultOpen>
      <OrganizationSwitcherView
        organizations={[organization, acme]}
        organizationId={organization.organizationId}
        onSelect={onSelect}
        onOpenSettings={onOpenSettings}
        onOpenInvite={onOpenInvite}
      />
    </DropdownMenuPrimitive.Root>,
  );
  return { onSelect, onOpenSettings, onOpenInvite };
}

describe("web organization switcher", () => {
  it("shows admin actions and all workspace choices", () => {
    const { onOpenInvite } = renderSwitcher();

    expect(screen.getByText("4 members")).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Personal/ })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: /Acme Studio/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Invite members" }));
    expect(onOpenInvite).toHaveBeenCalledWith(northwind);

    cleanup();
    const { onOpenSettings } = renderSwitcher();
    fireEvent.click(screen.getByRole("menuitem", { name: "Organization settings" }));
    expect(onOpenSettings).toHaveBeenCalledWith(northwind.organizationId);
  });

  it("lets members open the read-only organization page from the member count", () => {
    const memberOrganization = { ...northwind, role: "org:member" as const };
    const { onOpenSettings } = renderSwitcher(memberOrganization);

    expect(screen.queryByRole("menuitem", { name: "Invite members" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Organization settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View 4 members" }));
    expect(onOpenSettings).toHaveBeenCalledWith(memberOrganization.organizationId);
  });

  it("activates and remembers the personal workspace", async () => {
    apiState.get.mockResolvedValue({ complete: true, organizations: [northwind, acme] });
    render(<OrganizationSwitcher onOpenSettings={() => undefined} />);

    const trigger = await screen.findByRole("button", { name: /Switch organization/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Personal/ }));

    expect(clerkState.setActive).toHaveBeenCalledWith({ organization: null });
    expect(readOrganizationSelection("user_nima")).toBe("personal");
  });

  it("rolls back a remembered selection when Clerk rejects the switch", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    clerkState.setActive.mockRejectedValue(new TypeError("network"));
    apiState.get.mockResolvedValue({ complete: true, organizations: [northwind, acme] });
    render(<OrganizationSwitcher onOpenSettings={() => undefined} />);

    const trigger = await screen.findByRole("button", { name: /Switch organization/ });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: /Personal/ }));

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(readOrganizationSelection("user_nima")).toBeNull();
  });
});

describe("web organization settings", () => {
  it("renders the admin directory and pending invitations", () => {
    render(<OrganizationSectionView organization={northwind} currentActorId="user_nima" members={members} invitations={invitations} onOpenInvite={() => undefined} />);

    expect(screen.getByRole("heading", { name: "Organization" })).toBeTruthy();
    expect(screen.getByText(/Nima Boscarino/)).toBeTruthy();
    expect(screen.getByText("sam@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite members" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change logo" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rename" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete organization" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Role for Nima Boscarino" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Actions for Nima Boscarino" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resend invitation to sam@example.com" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revoke invitation for sam@example.com" })).toBeTruthy();
    expect(screen.queryByText("Owner")).toBeNull();
  });

  it("renders a member-safe view and leave confirmation", () => {
    render(<OrganizationSectionView organization={{ ...northwind, role: "org:member" }} currentActorId="user_ava" members={members} invitations={[]} onOpenInvite={() => undefined} />);

    expect(screen.getByText("You’re a member of Northwind.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change logo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Leave Northwind" }));
    expect(screen.getByRole("alertdialog", { name: "Leave Northwind?" })).toBeTruthy();
    expect(screen.getByText(/lose access to everything shared with you in Northwind/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave", exact: true })).toBeTruthy();
  });

  it("guards the final admin", () => {
    render(<OrganizationSectionView organization={{ ...northwind, memberCount: 2 }} currentActorId="user_nima" members={members} invitations={[]} onOpenInvite={() => undefined} />);

    expect(screen.getByText(/only Admin/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make someone Admin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave organization" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete organization" })).toBeTruthy();
  });

  it("matches the multi-email invitation form and exposes only Clerk roles", () => {
    const onSubmit = vi.fn();
    render(<InviteMembersDialog organization={northwind} open onOpenChange={() => undefined} onSubmit={onSubmit} />);

    const emailInput = screen.getByRole("textbox", { name: "Emails" });
    fireEvent.change(emailInput, { target: { value: "sam@example.com" } });
    fireEvent.keyDown(emailInput, { key: "Enter" });
    fireEvent.change(emailInput, { target: { value: "lee@example.com" } });
    fireEvent.keyDown(emailInput, { key: "," });
    expect(screen.getByText("sam@example.com")).toBeTruthy();
    expect(screen.getByText("lee@example.com")).toBeTruthy();
    expect((screen.getByRole("combobox", { name: "Role" }) as HTMLSelectElement).value).toBe("org:member");
    expect(screen.queryByRole("option", { name: "Owner" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send invites" }));
    expect(onSubmit).toHaveBeenCalledWith({ emailAddresses: ["sam@example.com", "lee@example.com"], role: "org:member" });
  });

  it("wires the active organization to platform directory reads", async () => {
    apiState.get.mockImplementation(async (path: string) => {
      if (path === "/api/organizations") return { complete: true, organizations: [northwind] };
      if (path === "/api/organizations/org_northwind/members") return { members: [members[0]], nextCursor: "next-page" };
      if (path === "/api/organizations/org_northwind/members?cursor=next-page") return { members: [members[1]] };
      if (path === "/api/organizations/org_northwind/invitations") return { invitations };
      throw new Error(`Unexpected path: ${path}`);
    });

    render(<OrganizationSection />);

    expect(await screen.findByText(/Nima Boscarino/)).toBeTruthy();
    expect(apiState.get).toHaveBeenCalledWith("/api/organizations/org_northwind/members");
    expect(apiState.get).toHaveBeenCalledWith("/api/organizations/org_northwind/members?cursor=next-page");
    expect(apiState.get).toHaveBeenCalledWith("/api/organizations/org_northwind/invitations");
  });

  it("wires rename and member removal to the organization mutation API", async () => {
    apiState.get.mockImplementation(async (path: string) => {
      if (path === "/api/organizations") return { complete: true, organizations: [northwind] };
      if (path === "/api/organizations/org_northwind/members") return { members };
      if (path === "/api/organizations/org_northwind/invitations") return { invitations: [] };
      throw new Error(`Unexpected path: ${path}`);
    });
    apiState.patch.mockResolvedValue({ ok: true });
    apiState.delete.mockResolvedValue({ ok: true });

    render(<OrganizationSection />);
    await screen.findByText(/Nima Boscarino/);
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Organization name" }), { target: { value: "Northwind Labs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(apiState.patch).toHaveBeenCalledWith("/api/organizations/org_northwind", { name: "Northwind Labs" }));

    await screen.findByText(/Ava Chen/);
    fireEvent.click(screen.getByRole("button", { name: "Actions for Ava Chen" }));
    expect(screen.getByRole("alertdialog", { name: "Remove Ava Chen?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));
    await waitFor(() => expect(apiState.delete).toHaveBeenCalledWith("/api/organizations/org_northwind/members/user_ava"));
  });

  it("wires every remaining admin control to the organization mutation API", async () => {
    apiState.get.mockImplementation(async (path: string) => {
      if (path === "/api/organizations") return { complete: true, organizations: [northwind] };
      if (path === "/api/organizations/org_northwind/members") return { members };
      if (path === "/api/organizations/org_northwind/invitations") return { invitations };
      throw new Error(`Unexpected path: ${path}`);
    });
    apiState.post.mockResolvedValue({ ok: true });
    apiState.patch.mockResolvedValue({ ok: true });
    apiState.delete.mockResolvedValue({ ok: true });

    render(<OrganizationSection />);
    await screen.findByText(/Nima Boscarino/);

    fireEvent.change(screen.getByRole("combobox", { name: "Role for Ava Chen" }), { target: { value: "org:admin" } });
    await waitFor(() => expect(apiState.patch).toHaveBeenCalledWith("/api/organizations/org_northwind/members/user_ava", { role: "org:admin" }));

    fireEvent.click(screen.getByRole("button", { name: "Resend invitation to sam@example.com" }));
    await waitFor(() => expect(apiState.post).toHaveBeenCalledWith("/api/organizations/org_northwind/invitations/orginv_pending/resend", {}));
    fireEvent.click(screen.getByRole("button", { name: "Revoke invitation for sam@example.com" }));
    await waitFor(() => expect(apiState.delete).toHaveBeenCalledWith("/api/organizations/org_northwind/invitations/orginv_pending"));

    const logo = new File(["logo"], "logo.png", { type: "image/png" });
    fireEvent.change(screen.getByLabelText("Organization logo file"), { target: { files: [logo] } });
    await waitFor(() => expect(apiState.patch).toHaveBeenCalledWith("/api/organizations/org_northwind/logo", expect.any(FormData)));

    fireEvent.click(screen.getByRole("button", { name: "Invite members" }));
    const emailInput = screen.getByRole("textbox", { name: "Emails" });
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invites" }));
    await waitFor(() => expect(apiState.post).toHaveBeenCalledWith("/api/organizations/org_northwind/invitations", { emailAddresses: ["new@example.com"], role: "org:member" }));

    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Delete organization" }).at(-1)!);
    await waitFor(() => expect(apiState.delete).toHaveBeenCalledWith("/api/organizations/org_northwind"));
    expect(clerkState.setActive).toHaveBeenCalledWith({ organization: null });
  });

  it("wires member leave and last-admin handoff", async () => {
    const memberOrganization = { ...northwind, role: "org:member" as const };
    apiState.get.mockImplementation(async (path: string) => {
      if (path === "/api/organizations") return { complete: true, organizations: [memberOrganization] };
      if (path === "/api/organizations/org_northwind/members") return { members };
      throw new Error(`Unexpected path: ${path}`);
    });
    apiState.patch.mockResolvedValue({ ok: true });
    apiState.delete.mockResolvedValue({ ok: true });

    render(<OrganizationSection />);
    await screen.findByText(/Nima Boscarino/);
    fireEvent.click(screen.getByRole("button", { name: "Leave Northwind" }));
    fireEvent.click(screen.getByRole("button", { name: "Leave", exact: true }));
    await waitFor(() => expect(apiState.delete).toHaveBeenCalledWith("/api/organizations/org_northwind/members/user_nima"));
    expect(clerkState.setActive).toHaveBeenCalledWith({ organization: null });

    cleanup();
    clerkState.setActive.mockClear();
    apiState.get.mockImplementation(async (path: string) => {
      if (path === "/api/organizations") return { complete: true, organizations: [{ ...northwind, memberCount: 2 }] };
      if (path === "/api/organizations/org_northwind/members") return { members };
      if (path === "/api/organizations/org_northwind/invitations") return { invitations: [] };
      throw new Error(`Unexpected path: ${path}`);
    });
    render(<OrganizationSection />);
    await screen.findByText(/only Admin/i);
    fireEvent.click(screen.getByRole("button", { name: "Make someone Admin" }));
    fireEvent.click(screen.getByRole("button", { name: "Make Admin" }));
    await waitFor(() => expect(apiState.patch).toHaveBeenCalledWith("/api/organizations/org_northwind/members/user_ava", { role: "org:admin" }));
  });
});
