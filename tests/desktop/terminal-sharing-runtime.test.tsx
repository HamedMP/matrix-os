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
      resolveFirst({ runtime: { machineId: "10000000-0000-4000-8000-000000000001" } });
      await Promise.resolve();
    });
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: "vps:10000000-0000-4000-8000-000000000001" }),
      undefined,
    ));

    let resolveSecond!: (value: unknown) => void;
    const secondApi = { get: vi.fn(() => new Promise((resolve) => { resolveSecond = resolve; })) };
    act(() => useConnection.setState({ api: secondApi as never }));
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: null }),
      undefined,
    ));
    await act(async () => {
      resolveSecond({ runtime: { machineId: "10000000-0000-4000-8000-000000000002" } });
      await Promise.resolve();
    });
  });
});
