// @vitest-environment jsdom

import React from "react";
import { cleanup, render } from "@testing-library/react";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { ChatSharingButton } from "@desktop/renderer/src/features/chat/ChatSharingButton";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collaborationApi: null as null | { post(path: string, body: unknown): Promise<unknown> },
  sent: vi.fn(async () => undefined),
}));

vi.mock("@matrix-os/ui", () => ({
  ChatSharingButton: (props: { collaborationApi: typeof mocks.collaborationApi }) => {
    mocks.collaborationApi = props.collaborationApi;
    return <div>Share</div>;
  },
}));
vi.mock("@desktop/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => ({ post: mocks.sent, get: vi.fn(), delete: vi.fn(), baseUrl: "https://matrix.test" }),
}));
vi.mock("@desktop/renderer/src/features/chat/../collaboration/useCollaborationRuntime", () => ({
  useCollaborationRuntimeId: () => "vps:runtime",
}));
vi.mock("@desktop/renderer/src/features/chat/../collaboration/DesktopCollaborationOrganization", () => ({
  DesktopCollaborationOrganization: ({ children }: { children: (id: string) => React.ReactNode }) => children("org_test"),
}));

afterEach(() => { cleanup(); mocks.sent.mockClear(); mocks.collaborationApi = null; });

describe("Electron Chat live-share credential revocation", () => {
  it("clears local disclosure before submitting a live Chat scope, but not for preflight", async () => {
    const order: string[] = [];
    mocks.sent.mockImplementation(async () => { order.push("post"); });
    render(<ChatSharingButton api={{} as ApiClient} chatId="chat_one" copyText={vi.fn()}
      onLiveShareStart={() => order.push("clear")} />);
    const api = mocks.collaborationApi;
    expect(api).toBeTruthy();
    await api!.post("/api/collaboration/runtimes/vps%3Aruntime/scopes/preflight", { kind: "chat" });
    expect(order).toEqual(["post"]);
    await api!.post("/api/collaboration/runtimes/vps%3Aruntime/scopes", { kind: "chat" });
    expect(order).toEqual(["post", "clear", "post"]);
  });
});
