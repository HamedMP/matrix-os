// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CanonicalChatRoute } from "@desktop/renderer/src/features/chat/CanonicalChatRoute";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import { useTabs } from "@desktop/renderer/src/stores/tabs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const workspace = vi.hoisted(() => ({
  props: null as null | {
    onActiveChatChanged?: (chatId: string | null, title?: string) => void;
  },
}));

vi.mock("@desktop/renderer/src/features/chat/CanonicalChatWorkspace", () => ({
  CanonicalChatWorkspace: (props: typeof workspace.props) => {
    workspace.props = props;
    return <div>canonical workspace</div>;
  },
}));

function routeApi(): ApiClient {
  return {
    baseUrl: "https://matrix.test",
    get: vi.fn(async () => ({ items: [] })),
    getText: vi.fn(),
    getBlob: vi.fn(),
    post: vi.fn(),
    postBytes: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    putBytes: vi.fn(),
    delete: vi.fn(),
    putText: vi.fn(),
  };
}

describe("CanonicalChatRoute top-level tab ownership", () => {
  beforeEach(() => {
    workspace.props = null;
    useTabs.setState(useTabs.getInitialState(), true);
  });

  afterEach(cleanup);

  it("updates only the top-level Chat tab that owns a newly created conversation", async () => {
    const originalId = useTabs.getState().openTab({
      kind: "chat",
      title: "Existing chat",
      chatId: "chat-old",
      chatView: "conversation",
      closable: false,
    });
    const draftId = useTabs.getState().openTabInstance({
      kind: "chat",
      title: "Chat",
      chatView: "draft",
      closable: true,
    });

    render(
      <CanonicalChatRoute
        api={routeApi()}
        projectId={null}
        tabId={draftId}
        initialView="draft"
        active
        fallback={<div>legacy chat</div>}
      />,
    );

    expect(await screen.findByText("canonical workspace")).toBeTruthy();
    act(() => workspace.props?.onActiveChatChanged?.("chat-new", "New chat"));

    expect(useTabs.getState().tabs.find((tab) => tab.id === originalId)).toMatchObject({
      title: "Existing chat",
      chatId: "chat-old",
      chatView: "conversation",
      closable: false,
    });
    expect(useTabs.getState().tabs.find((tab) => tab.id === draftId)).toMatchObject({
      title: "New chat",
      chatId: "chat-new",
      chatView: "conversation",
      closable: true,
    });
    expect(useTabs.getState().activeTabId).toBe(draftId);
  });
});
