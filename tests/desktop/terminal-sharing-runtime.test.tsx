// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopTerminalSharing } from "../../desktop/src/renderer/src/features/terminal/DesktopTerminalSharing";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const sharingButton = vi.hoisted(() => vi.fn(() => null));

vi.mock("@matrix-os/ui", () => ({
  TerminalSharingButton: sharingButton,
  createCollaborationBrowserApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
}));

describe("DesktopTerminalSharing", () => {
  beforeEach(() => {
    sharingButton.mockClear();
    useConnection.setState({ api: null, platformHost: "https://app.matrix-os.com" });
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
