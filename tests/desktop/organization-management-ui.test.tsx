// @vitest-environment jsdom

import React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  OrganizationManagementInvitation,
  OrganizationManagementMember,
  OrganizationManagementSummary,
} from "@matrix-os/contracts";
import {
  OrganizationSwitcherView,
} from "@desktop/renderer/src/features/organization/OrganizationSwitcher";
import {
  OrganizationSectionView,
} from "@desktop/renderer/src/features/organization/OrganizationSection";
import OrganizationSection from "@desktop/renderer/src/features/organization/OrganizationSection";
import { InviteMembersDialog } from "@desktop/renderer/src/features/organization/OrganizationDialogs";
import { useConnection } from "@desktop/renderer/src/stores/connection";

const apiState = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), release: vi.fn() }));

vi.mock("@desktop/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => ({ get: apiState.get, post: apiState.post, patch: apiState.patch, delete: apiState.delete }),
  releaseDesktopCollaborationApi: apiState.release,
}));

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
  {
    actorId: "user_nima",
    displayName: "Nima Boscarino",
    emailAddress: "nima@example.com",
    role: "org:admin",
    joinedAt: "2026-10-01T10:00:00.000Z",
  },
  {
    actorId: "user_ava",
    displayName: "Ava Chen",
    emailAddress: "ava@example.com",
    role: "org:member",
    joinedAt: "2026-10-02T10:00:00.000Z",
  },
];

const invitations: OrganizationManagementInvitation[] = [{
  invitationId: "orginv_pending",
  emailAddress: "sam@example.com",
  role: "org:member",
  createdAt: "2026-10-03T10:00:00.000Z",
  expiresAt: "2026-10-10T10:00:00.000Z",
}];

beforeEach(() => {
  apiState.get.mockReset();
  apiState.post.mockReset();
  apiState.patch.mockReset();
  apiState.delete.mockReset();
  apiState.release.mockReset();
  useConnection.setState({
    status: "signed-in",
    userId: "user_nima",
    organizationId: "org_northwind",
    platformHost: "https://app.matrix-os.com",
  });
});

afterEach(cleanup);

function renderSwitcher(organization: OrganizationManagementSummary = northwind) {
  const onSelect = vi.fn();
  const onOpenSettings = vi.fn();
  const onOpenInvite = vi.fn();
  render(
    <DropdownMenu.Root defaultOpen>
      <OrganizationSwitcherView
        organizations={[organization, acme]}
        organizationId={organization.organizationId}
        onSelect={onSelect}
        onOpenSettings={onOpenSettings}
        onOpenInvite={onOpenInvite}
      />
    </DropdownMenu.Root>,
  );
  return { onSelect, onOpenSettings, onOpenInvite };
}

describe("OrganizationSwitcherView", () => {
  it("shows admin actions, member count, and organization choices", () => {
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

  it("represents the personal workspace as a real selection", () => {
    const onSelect = vi.fn();
    render(
      <DropdownMenu.Root defaultOpen>
        <OrganizationSwitcherView
          organizations={[northwind, acme]}
          organizationId={null}
          onSelect={onSelect}
          onOpenSettings={() => undefined}
          onOpenInvite={() => undefined}
        />
      </DropdownMenu.Root>,
    );

    expect(screen.getByRole("menu", { name: /current organization Personal/ })).toBeTruthy();
    const personal = screen.getByRole("menuitemradio", { name: /Personal/ });
    expect(personal.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(personal);
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

describe("OrganizationSectionView", () => {
  it("renders members and pending invitations for an admin", () => {
    render(
      <OrganizationSectionView
        organization={northwind}
        currentActorId="user_nima"
        members={members}
        invitations={invitations}
        onOpenInvite={() => undefined}
      />,
    );

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

  it("renders a read-only member view", () => {
    render(
      <OrganizationSectionView
        organization={{ ...northwind, role: "org:member" }}
        currentActorId="user_ava"
        members={members}
        invitations={[]}
        onOpenInvite={() => undefined}
      />,
    );

    expect(screen.getByText("You’re a member of Northwind.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Change logo" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete organization" })).toBeNull();
    expect(screen.queryByText("Pending invitations")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.getByRole("button", { name: "Leave Northwind" })).toBeTruthy();
  });

  it("guards the final admin from leaving and explains the remedy", () => {
    render(
      <OrganizationSectionView
        organization={{ ...northwind, memberCount: 2 }}
        currentActorId="user_nima"
        members={members}
        invitations={[]}
        onOpenInvite={() => undefined}
      />,
    );

    expect(screen.getByText(/only Admin/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make someone Admin" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave organization" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Delete organization" })).toBeTruthy();
  });

  it("opens the leave confirmation for an ordinary member", () => {
    render(
      <OrganizationSectionView
        organization={{ ...northwind, role: "org:member" }}
        currentActorId="user_ava"
        members={members}
        invitations={[]}
        onOpenInvite={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Leave Northwind" }));
    expect(screen.getByRole("alertdialog", { name: "Leave Northwind?" })).toBeTruthy();
    expect(screen.getByText(/lose access to everything shared with you in Northwind/i)).toBeTruthy();
    expect(screen.getByText(/What you shared with Northwind stops being shared/i)).toBeTruthy();
    expect(screen.getByText(/An admin has to invite you to come back/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave", exact: true })).toBeTruthy();
  });

  it("matches the multi-email invitation form and exposes only Clerk roles", () => {
    const onSubmit = vi.fn();
    render(
      <InviteMembersDialog
        organization={northwind}
        open
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    );

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
    expect(onSubmit).toHaveBeenCalledWith({
      emailAddresses: ["sam@example.com", "lee@example.com"],
      role: "org:member",
    });
  });

  it("wires the selected organization to the member and invitation reads", async () => {
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
    expect(apiState.release).toHaveBeenCalledTimes(2);
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
});
