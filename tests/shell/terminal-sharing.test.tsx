// @vitest-environment jsdom

import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const organization = vi.hoisted(() => ({ current: { id: "org_matrix_team" } as { id: string } | null }));

vi.mock("@clerk/nextjs", () => ({
  useOrganization: () => ({ organization: organization.current }),
}));

vi.mock("@matrix-os/ui", () => ({
  // Holds per-terminal UI state the way the real control does (open dialog,
  // pending preflight), so a stale instance is observable after a switch.
  TerminalSharingButton: ({ terminalId, organizationId }: { terminalId: string; organizationId: string | null }) => {
    const [openedFor, setOpenedFor] = useState<string | null>(null);
    return (
      <button type="button" data-organization={organizationId ?? ""} onClick={() => setOpenedFor(terminalId)}>
        {openedFor ? `Sharing ${openedFor}` : `Share ${terminalId}`}
      </button>
    );
  },
}));

vi.mock("@/lib/collaboration", () => ({
  createShellCollaborationApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
  collaborationRuntimeFromSystemInfo: () => ({ runtimeId: "vps:10000000-0000-4000-8000-000000000001" }),
}));

import { TerminalSharing } from "../../shell/src/components/terminal/TerminalSharing.js";

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("TerminalSharing", () => {
  beforeEach(() => {
    organization.current = { id: "org_matrix_team" };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts a fresh Share control when the focused terminal changes", async () => {
    const view = render(<TerminalSharing terminalId="terminal_one" />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Share terminal_one" }));
    expect(screen.getByRole("button", { name: "Sharing terminal_one" })).toBeTruthy();

    view.rerender(<TerminalSharing terminalId="terminal_two" />);

    expect(screen.getByRole("button", { name: "Share terminal_two" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Sharing terminal_one/ })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the active Clerk organization to the shared control", async () => {
    render(<TerminalSharing terminalId="terminal_one" />);
    await settle();
    expect(screen.getByRole("button", { name: "Share terminal_one" }).getAttribute("data-organization")).toBe("org_matrix_team");
  });
});
