// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSharingButton } from "../../desktop/src/renderer/src/features/chat/ChatSharingButton";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const sharingButton = vi.hoisted(() => vi.fn(() => null));

vi.mock("@matrix-os/ui", () => ({
  ChatSharingButton: sharingButton,
  createCollaborationBrowserApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
}));

describe("Electron Desktop ChatSharingButton", () => {
  beforeEach(() => {
    sharingButton.mockClear();
    useConnection.setState({ api: null, platformHost: "https://app.matrix-os.com", organizationId: null, handle: "owner", runtimeSlot: "primary" });
  });

  it("passes the active organization from the connection state and remounts the button when it changes", async () => {
    const api = { get: vi.fn(async () => ({ runtime: { machineId: "10000000-0000-4000-8000-000000000001" }, capabilities: { collaboration: true } })) };
    render(<ChatSharingButton api={api as never} chatId="chat_release" copyText={async () => undefined} />);
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ runtimeId: "vps:10000000-0000-4000-8000-000000000001", organizationId: null, collaborationEnabled: true }),
      undefined,
    ));
    act(() => useConnection.setState({ organizationId: "org_matrix_team" }));
    await waitFor(() => expect(sharingButton).toHaveBeenLastCalledWith(
      expect.objectContaining({ organizationId: "org_matrix_team" }),
      undefined,
    ));
  });
});
