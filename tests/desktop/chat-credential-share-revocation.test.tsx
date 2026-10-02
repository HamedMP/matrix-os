// @vitest-environment jsdom

import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { ChatSharingButton } from "@desktop/renderer/src/features/chat/ChatSharingButton";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  collaborationApi: null as null | { post(path: string, body: unknown): Promise<unknown> },
  sent: vi.fn(async () => undefined),
}));

vi.mock("@matrix-os/ui", () => ({
  ChatSharingButton: (props: { collaborationApi: typeof mocks.collaborationApi; organizationId: string | null }) => {
    const [draft, setDraft] = React.useState("clean");
    mocks.collaborationApi = props.collaborationApi;
    return <div>
      <span data-testid="share-state">{`${props.organizationId ?? "none"}:${draft}`}</span>
      <button type="button" onClick={() => setDraft("open")}>Open share</button>
    </div>;
  },
}));
vi.mock("@desktop/renderer/src/lib/collaboration", () => ({
  createDesktopCollaborationApi: () => ({ post: mocks.sent, get: vi.fn(), delete: vi.fn(), baseUrl: "https://matrix.test" }),
  releaseDesktopCollaborationApi: vi.fn(),
}));
vi.mock("@desktop/renderer/src/features/chat/../collaboration/useCollaborationRuntime", () => ({
  useCollaborationRuntimeId: () => "vps:runtime",
}));
beforeEach(() => {
  useConnection.setState({
    platformHost: "https://matrix.test",
    organizationId: "org_alpha",
    organizationStatus: "member",
  });
});

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

  it("clears organization-bound Chat share state when the active organization changes", () => {
    render(<ChatSharingButton api={{} as ApiClient} chatId="chat_one" copyText={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Open share" }));
    expect(screen.getByTestId("share-state")).toHaveTextContent("org_alpha:open");

    act(() => useConnection.setState({ organizationId: "org_beta", organizationStatus: "member" }));

    expect(screen.getByTestId("share-state")).toHaveTextContent("org_beta:clean");
  });

  it("keeps snapshot sharing visible without treating a remembered organization as verified", () => {
    useConnection.setState({ organizationId: "org_stale", organizationStatus: "unavailable" });
    render(<ChatSharingButton api={{} as ApiClient} chatId="chat_one" copyText={vi.fn()} />);

    expect(screen.getByTestId("share-state")).toHaveTextContent("none:clean");
    expect(mocks.collaborationApi).toBeTruthy();
  });
});
