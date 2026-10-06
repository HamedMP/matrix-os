// @vitest-environment jsdom

import React from "react";
import "@testing-library/jest-dom/vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  organizationLoaded: true,
  organization: null as { id: string } | null,
  organizationsLoaded: true,
  memberships: [] as Array<{ organization: { id: string; name: string } }>,
  hasNextPage: false,
  isFetching: false,
  isError: false,
  fetchNext: vi.fn(),
  userId: "user_a" as string | null,
  setActive: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useAuth: () => ({ userId: clerkState.userId }),
  useOrganization: () => ({ isLoaded: clerkState.organizationLoaded, organization: clerkState.organization }),
  useOrganizationList: () => ({
    isLoaded: clerkState.organizationsLoaded,
    // A fresh function per render, as Clerk may return: the effect re-runs, so only the
    // one-attempt guard stops a failed activation from retrying on every render.
    setActive: (params: unknown) => clerkState.setActive(params),
    userMemberships: {
      data: clerkState.memberships,
      hasNextPage: clerkState.hasNextPage,
      isFetching: clerkState.isFetching,
      isError: clerkState.isError,
      fetchNext: clerkState.fetchNext,
    },
  }),
}));

import { DefaultOrganization } from "../../shell/src/components/DefaultOrganization";
import { useCollaborationOrganization } from "../../shell/src/lib/collaboration-organization-state";

function member(id: string) {
  return { organization: { id, name: id } };
}

function OrganizationState() {
  const state = useCollaborationOrganization();
  return <span>{`${state.status}:${state.organizationId ?? "none"}`}</span>;
}

beforeEach(() => {
  clerkState.organizationLoaded = true;
  clerkState.organization = null;
  clerkState.organizationsLoaded = true;
  clerkState.memberships = [];
  clerkState.hasNextPage = false;
  clerkState.isFetching = false;
  clerkState.isError = false;
  clerkState.fetchNext.mockReset();
  clerkState.userId = "user_a";
  clerkState.setActive.mockReset();
  clerkState.setActive.mockResolvedValue(undefined);
});

describe("DefaultOrganization", () => {
  it("activates the oldest organization for a member who never chose one", async () => {
    clerkState.memberships = [member("org_2Znewer"), member("org_2Aolder")];
    render(<DefaultOrganization />);

    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledWith({ organization: "org_2Aolder" }));
  });

  it("leaves an organization the member already has active", () => {
    clerkState.organization = { id: "org_2Znewer" };
    clerkState.memberships = [member("org_2Znewer"), member("org_2Aolder")];
    render(<DefaultOrganization />);

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("keeps an individual user individual: no organization, nothing activated", () => {
    render(<DefaultOrganization><OrganizationState /></DefaultOrganization>);

    expect(clerkState.setActive).not.toHaveBeenCalled();
    expect(screen.getByText("none:none")).toBeVisible();
  });

  it("keeps organization-only controls present while memberships are loading", () => {
    clerkState.organizationsLoaded = false;
    render(<DefaultOrganization><OrganizationState /></DefaultOrganization>);

    expect(screen.getByText("loading:none")).toBeVisible();
  });

  it("reports a membership-list failure instead of treating it as no organizations", () => {
    clerkState.isError = true;
    render(<DefaultOrganization><OrganizationState /></DefaultOrganization>);

    expect(screen.getByText("unavailable:none")).toBeVisible();
  });

  it("reports the active organization without waiting for the membership listing", () => {
    clerkState.organization = { id: "org_active" };
    clerkState.organizationsLoaded = false;
    render(<DefaultOrganization><OrganizationState /></DefaultOrganization>);

    expect(screen.getByText("member:org_active")).toBeVisible();
  });

  it("waits for Clerk before deciding there is no active organization", () => {
    clerkState.organizationLoaded = false;
    clerkState.memberships = [member("org_2Aolder")];
    render(<DefaultOrganization />);

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("loads every membership page before choosing, so a later page's older organization wins", async () => {
    clerkState.memberships = [member("org_2Znewer")];
    clerkState.hasNextPage = true;
    const { rerender } = render(<DefaultOrganization />);

    await waitFor(() => expect(clerkState.fetchNext).toHaveBeenCalledTimes(1));
    expect(clerkState.setActive).not.toHaveBeenCalled();

    clerkState.memberships = [member("org_2Znewer"), member("org_2Aolder")];
    clerkState.hasNextPage = false;
    rerender(<DefaultOrganization />);

    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledWith({ organization: "org_2Aolder" }));
    expect(clerkState.setActive).toHaveBeenCalledTimes(1);
  });

  it("does not request another page while one is already loading", () => {
    clerkState.memberships = [member("org_2Znewer")];
    clerkState.hasNextPage = true;
    clerkState.isFetching = true;
    render(<DefaultOrganization />);

    expect(clerkState.fetchNext).not.toHaveBeenCalled();
    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("never re-requests a membership page that failed to load", () => {
    clerkState.memberships = [member("org_2Znewer")];
    clerkState.hasNextPage = true;
    clerkState.isError = true;
    const { rerender } = render(<DefaultOrganization />);
    clerkState.isFetching = true;
    rerender(<DefaultOrganization />);
    clerkState.isFetching = false;
    rerender(<DefaultOrganization />);

    expect(clerkState.fetchNext).not.toHaveBeenCalled();
    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("chooses nothing from a membership list that failed to load", () => {
    clerkState.memberships = [member("org_2Znewer")];
    clerkState.isError = true;
    render(<DefaultOrganization />);

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("still activates for the next account when it shares the previous account's oldest organization", async () => {
    clerkState.memberships = [member("org_2Aolder")];
    const { rerender } = render(<DefaultOrganization />);
    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledTimes(1));

    clerkState.userId = "user_b";
    rerender(<DefaultOrganization />);

    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledTimes(2));
  });

  it("reports a failed activation as unavailable and does not loop", async () => {
    clerkState.memberships = [member("org_2Aolder")];
    clerkState.setActive.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rerender } = render(<DefaultOrganization><OrganizationState /></DefaultOrganization>);
    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("unavailable:none")).toBeVisible();

    rerender(<DefaultOrganization><OrganizationState /></DefaultOrganization>);
    await Promise.resolve();

    expect(clerkState.setActive).toHaveBeenCalledTimes(1);
  });
});
