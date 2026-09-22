// @vitest-environment jsdom

import React, { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const organizationState = vi.hoisted(() => ({ organization: null as { id: string } | null }));
vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: organizationState.organization }),
}));

import { CollaborationOrganization } from "../../shell/src/lib/collaboration-organization.js";

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
    organizationState.organization = { id: "org_alpha" };
    const { rerender } = render(<CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>);
    fireEvent.click(screen.getByRole("button", { name: "preflight" }));
    expect(screen.getByTestId("token")).toHaveTextContent("preflight-for-org_alpha");

    organizationState.organization = { id: "org_beta" };
    act(() => rerender(<CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>));
    expect(screen.getByTestId("organization")).toHaveTextContent("org_beta");
    expect(screen.getByTestId("token")).toHaveTextContent("none");

    organizationState.organization = null;
    act(() => rerender(<CollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</CollaborationOrganization>));
    expect(screen.getByTestId("organization")).toHaveTextContent("none");
  });
});
