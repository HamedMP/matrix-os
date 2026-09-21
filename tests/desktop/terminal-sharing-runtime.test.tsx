// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopTerminalSharing } from "../../desktop/src/renderer/src/features/terminal/DesktopTerminalSharing";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";
import { DesktopCollaborationOrganization } from "../../desktop/src/renderer/src/features/collaboration/DesktopCollaborationOrganization";
import { useState } from "react";

const sharingButton = vi.hoisted(() => vi.fn(() => null));

vi.mock("@matrix-os/ui", () => ({
  TerminalSharingButton: sharingButton,
  createCollaborationBrowserApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
}));

describe("DesktopTerminalSharing", () => {
  beforeEach(() => {
    sharingButton.mockClear();
    useConnection.setState({ api: null, platformHost: "https://app.matrix-os.com", organizationId: null });
  });

  it("passes the active organization from the connection state and disables sharing without one", async () => {
    const api = { get: vi.fn(async () => ({ runtime: { machineId: "10000000-0000-4000-8000-000000000001" }, capabilities: { collaboration: true } })) };
    useConnection.setState({ api: api as never, organizationId: null });
    render(<DesktopTerminalSharing terminalId="terminal_release" />);
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: "vps:10000000-0000-4000-8000-000000000001", organizationId: null }),
      undefined,
    ));
    act(() => useConnection.setState({ organizationId: "org_matrix_team" }));
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: "org_matrix_team" }),
      undefined,
    ));
  });

  it("clears the previous runtime identity while a replacement computer loads", async () => {
    let resolveFirst!: (value: unknown) => void;
    const firstApi = { get: vi.fn(() => new Promise((resolve) => { resolveFirst = resolve; })) };
    useConnection.setState({ api: firstApi as never });
    render(<DesktopTerminalSharing terminalId="terminal_release" />);
    await act(async () => {
      resolveFirst({ runtime: { machineId: "10000000-0000-4000-8000-000000000001" }, capabilities: { collaboration: true } });
      await Promise.resolve();
    });
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: "vps:10000000-0000-4000-8000-000000000001" }),
      undefined,
    ));

    let resolveSecond!: (value: unknown) => void;
    const secondApi = { get: vi.fn(() => new Promise((resolve) => { resolveSecond = resolve; })) };
    act(() => useConnection.setState({ api: secondApi as never }));
    await waitFor(() => expect(sharingButton).toHaveBeenCalledTimes(1));
    await act(async () => {
      resolveSecond({ runtime: { machineId: "10000000-0000-4000-8000-000000000002" }, capabilities: { collaboration: true } });
      await Promise.resolve();
    });
  });

  it("does not render collaboration controls when the computer flag is off", async () => {
    const api = { get: vi.fn(async () => ({
      runtime: { machineId: "10000000-0000-4000-8000-000000000001" },
      capabilities: { collaboration: false },
    })) };
    useConnection.setState({ api: api as never });
    render(<DesktopTerminalSharing terminalId="terminal_release" />);
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(sharingButton).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy client does not expose bounded JSON reads", async () => {
    useConnection.setState({ api: {} as never });

    render(<DesktopTerminalSharing terminalId="terminal_release" />);

    await act(async () => { await Promise.resolve(); });
    expect(sharingButton).not.toHaveBeenCalled();
  });

  it("fails closed when a legacy JSON read returns no request promise", async () => {
    useConnection.setState({ api: { get: vi.fn(() => undefined) } as never });

    render(<DesktopTerminalSharing terminalId="terminal_release" />);

    await act(async () => { await Promise.resolve(); });
    expect(sharingButton).not.toHaveBeenCalled();
  });
});

describe("DesktopCollaborationOrganization gate", () => {
  it("remounts the sharing subtree when the active organization changes", async () => {
    function StatefulChild({ organizationId }: { organizationId: string | null }) {
      const [token, setToken] = useState<string | null>(null);
      return <div>
        <span data-testid="organization">{organizationId ?? "none"}</span>
        <span data-testid="token">{token ?? "none"}</span>
        <button type="button" onClick={() => setToken(`preflight-for-${organizationId ?? "none"}`)}>preflight</button>
      </div>;
    }
    useConnection.setState({ organizationId: "org_alpha" });
    const view = render(<DesktopCollaborationOrganization>{(id) => <StatefulChild organizationId={id} />}</DesktopCollaborationOrganization>);
    act(() => { view.getByRole("button", { name: "preflight" }).click(); });
    await waitFor(() => expect(view.getByTestId("token").textContent).toBe("preflight-for-org_alpha"));
    act(() => useConnection.setState({ organizationId: "org_beta" }));
    await waitFor(() => expect(view.getByTestId("organization").textContent).toBe("org_beta"));
    expect(view.getByTestId("token").textContent).toBe("none");
  });
});
