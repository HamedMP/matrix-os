// @vitest-environment jsdom

import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const organizationState = vi.hoisted(() => ({ organization: null as { id: string } | null }));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: organizationState.organization }),
}));

import {
  CollaborationOrganization,
  OrganizationOnly,
} from "../../shell/src/lib/collaboration-organization.js";
import {
  OrganizationStateProvider,
  useCollaborationOrganization,
} from "../../shell/src/lib/collaboration-organization-state.js";

function StatefulChild({ organizationId }: { organizationId: string | null }) {
  // Stands in for a share flow holding organization-bound state (a preflight token, an open scope).
  const [token, setToken] = useState<string | null>(null);
  return <div>
    <span data-testid="organization">{organizationId ?? "none"}</span>
    <span data-testid="token">{token ?? "none"}</span>
    <button type="button" onClick={() => setToken(`preflight-for-${organizationId ?? "none"}`)}>preflight</button>
  </div>;
}

describe("CollaborationOrganization gate", () => {
  afterEach(() => {
    organizationState.organization = null;
  });

  it("remounts the sharing subtree when the active organization changes so no organization-bound state survives", () => {
    const { rerender } = render(<OrganizationStateProvider value={{ status: "member", organizationId: "org_alpha" }}>
      <CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>
    </OrganizationStateProvider>);
    fireEvent.click(screen.getByRole("button", { name: "preflight" }));
    expect(screen.getByTestId("token")).toHaveTextContent("preflight-for-org_alpha");

    act(() => rerender(<OrganizationStateProvider value={{ status: "member", organizationId: "org_beta" }}>
      <CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>
    </OrganizationStateProvider>));
    expect(screen.getByTestId("organization")).toHaveTextContent("org_beta");
    expect(screen.getByTestId("token")).toHaveTextContent("none");

    act(() => rerender(<OrganizationStateProvider value={{ status: "loading", organizationId: null }}>
      <CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>
    </OrganizationStateProvider>));
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });

  it("hides organization-only surfaces only after an empty membership list is confirmed", () => {
    const { rerender } = render(<OrganizationStateProvider value={{ status: "loading", organizationId: null }}>
      <OrganizationOnly><div>Organization surface</div></OrganizationOnly>
    </OrganizationStateProvider>);
    expect(screen.getByText("Organization surface")).toBeVisible();

    rerender(<OrganizationStateProvider value={{ status: "unavailable", organizationId: null }}>
      <OrganizationOnly><div>Organization surface</div></OrganizationOnly>
    </OrganizationStateProvider>);
    expect(screen.getByText("Organization surface")).toBeVisible();

    rerender(<OrganizationStateProvider value={{ status: "none", organizationId: null }}>
      <OrganizationOnly><div>Organization surface</div></OrganizationOnly>
    </OrganizationStateProvider>);
    expect(screen.queryByText("Organization surface")).toBeNull();
  });

  it("exposes the authoritative membership state to non-sharing navigation", () => {
    function State() {
      const value = useCollaborationOrganization();
      return <span>{`${value.status}:${value.organizationId ?? "none"}`}</span>;
    }
    render(<OrganizationStateProvider value={{ status: "none", organizationId: null }}><State /></OrganizationStateProvider>);
    expect(screen.getByText("none:none")).toBeVisible();
  });
});
