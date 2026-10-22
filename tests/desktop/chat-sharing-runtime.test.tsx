// @vitest-environment jsdom

import React from "react";
import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSharingButton } from "../../desktop/src/renderer/src/features/chat/ChatSharingButton";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const { sharingButton, directClose, collaborationApi } = vi.hoisted(() => ({
  sharingButton: vi.fn(() => null),
  directClose: vi.fn(),
  collaborationApi: {
    baseUrl: "https://app.matrix-os.com",
    direct: { close: vi.fn() },
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("@matrix-os/ui", () => ({
  ChatSharingButton: sharingButton,
  createCollaborationBrowserApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
  createCollaborationDirectApi: () => ({ ...collaborationApi, direct: { close: directClose } }),
}));

describe("Electron Desktop ChatSharingButton", () => {
  beforeEach(() => {
    sharingButton.mockClear();
    directClose.mockClear();
    useConnection.setState({
      api: null,
      platformHost: "https://app.matrix-os.com",
      organizationId: "org_matrix_team",
      organizationStatus: "member",
      handle: "owner",
      runtimeSlot: "primary",
    });
  });

  it("keeps snapshot sharing primary and passes only a management adapter for legacy live access", async () => {
    const api = { get: vi.fn(async () => ({
      runtime: { machineId: "10000000-0000-4000-8000-000000000001" },
      capabilities: { collaboration: true },
    })) };
    render(<ChatSharingButton api={api as never} chatId="chat_release" copyText={async () => undefined} />);

    await waitFor(() => expect(sharingButton.mock.lastCall?.[0]).toEqual(expect.objectContaining({
      api,
      chatId: "chat_release",
      handle: "owner",
      runtimeSlot: "primary",
      platformHost: "https://app.matrix-os.com",
      legacyCollaboration: expect.objectContaining({
        runtimeId: "vps:10000000-0000-4000-8000-000000000001",
        organizationId: "org_matrix_team",
      }),
    })));
    const props = sharingButton.mock.lastCall?.[0];
    for (const creationProp of ["collaborationEnabled", "collaborationApi", "runtimeId", "organizationId"]) {
      expect(props).not.toHaveProperty(creationProp);
    }
  });

  it("releases the legacy management API when organization access disappears", async () => {
    const api = { get: vi.fn(async () => ({
      runtime: { machineId: "10000000-0000-4000-8000-000000000001" },
      capabilities: { collaboration: true },
    })) };
    render(<ChatSharingButton api={api as never} chatId="chat_release" copyText={async () => undefined} />);
    await waitFor(() => expect(sharingButton).toHaveBeenCalled());

    act(() => useConnection.setState({ organizationId: null, organizationStatus: "none" }));

    expect(directClose).toHaveBeenCalledTimes(1);
  });
});
