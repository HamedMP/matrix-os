// @vitest-environment jsdom

import React from "react";
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const clerkState = vi.hoisted(() => ({
  organizationLoaded: true,
  organization: null as { id: string } | null,
  organizationsLoaded: true,
  memberships: [] as Array<{ organization: { id: string; name: string } }>,
  setActive: vi.fn(),
}));

vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ isLoaded: clerkState.organizationLoaded, organization: clerkState.organization }),
  useOrganizationList: () => ({
    isLoaded: clerkState.organizationsLoaded,
    // A fresh function per render, as Clerk may return: the effect re-runs, so only the
    // one-attempt guard stops a failed activation from retrying on every render.
    setActive: (params: unknown) => clerkState.setActive(params),
    userMemberships: { data: clerkState.memberships },
  }),
}));

import { DefaultOrganization } from "../../shell/src/components/DefaultOrganization";

function member(id: string) {
  return { organization: { id, name: id } };
}

beforeEach(() => {
  clerkState.organizationLoaded = true;
  clerkState.organization = null;
  clerkState.organizationsLoaded = true;
  clerkState.memberships = [];
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
    render(<DefaultOrganization />);

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("waits for Clerk before deciding there is no active organization", () => {
    clerkState.organizationLoaded = false;
    clerkState.memberships = [member("org_2Aolder")];
    render(<DefaultOrganization />);

    expect(clerkState.setActive).not.toHaveBeenCalled();
  });

  it("tries a failed activation once instead of looping on every render", async () => {
    clerkState.memberships = [member("org_2Aolder")];
    clerkState.setActive.mockRejectedValue(new Error("network"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { rerender } = render(<DefaultOrganization />);
    await waitFor(() => expect(clerkState.setActive).toHaveBeenCalledTimes(1));

    rerender(<DefaultOrganization />);
    await Promise.resolve();

    expect(clerkState.setActive).toHaveBeenCalledTimes(1);
  });
});
