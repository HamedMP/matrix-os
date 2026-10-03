// @vitest-environment jsdom

import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSharingButton } from "../../desktop/src/renderer/src/features/chat/ChatSharingButton";
import { useConnection } from "../../desktop/src/renderer/src/stores/connection";

const sharingButton = vi.hoisted(() => vi.fn((_props: Record<string, unknown>) => null));

vi.mock("@matrix-os/ui", () => ({
  ChatSharingButton: sharingButton,
  createCollaborationBrowserApi: () => ({ baseUrl: "https://app.matrix-os.com" }),
  createCollaborationDirectApi: () => ({ direct: { close: vi.fn() } }),
}));

describe("Electron Desktop ChatSharingButton", () => {
  beforeEach(() => {
    sharingButton.mockClear();
    useConnection.setState({ api: null, platformHost: "https://app.matrix-os.com", organizationId: "org_matrix_team", handle: "owner", runtimeSlot: "primary" });
  });

  it("hands the shared button only what a snapshot link needs, with no live collaboration", () => {
    const api = { get: vi.fn(async () => ({ runtime: { machineId: "10000000-0000-4000-8000-000000000001" }, capabilities: { collaboration: true } })) };
    render(<ChatSharingButton api={api as never} chatId="chat_release" copyText={async () => undefined} />);
    const props = sharingButton.mock.lastCall?.[0];
    expect(props).toEqual(expect.objectContaining({
      api, chatId: "chat_release", handle: "owner", runtimeSlot: "primary", platformHost: "https://app.matrix-os.com",
    }));
    for (const live of ["collaborationEnabled", "collaborationApi", "runtimeId", "organizationId"]) {
      expect(props).not.toHaveProperty(live);
    }
    // A live share needed the runtime identity; a snapshot never asks for it.
    expect(api.get).not.toHaveBeenCalled();
  });
});
