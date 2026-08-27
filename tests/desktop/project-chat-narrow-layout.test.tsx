// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { useBoard } from "@desktop/renderer/src/stores/board";
import { useConnection } from "@desktop/renderer/src/stores/connection";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");
const resizeObserverCallbacks: ResizeObserverCallback[] = [];

class WorkspaceResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallbacks.push(callback);
  }

  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

const record = {
  chat: {
    id: snapshot.chat.id,
    ownerScope: snapshot.chat.ownerScope,
    title: snapshot.chat.title,
    lifecycle: snapshot.chat.lifecycle,
    attention: snapshot.chat.attention,
    revision: snapshot.chat.revision,
    messageCount: snapshot.chat.messageCount,
    lastMessagePreview: snapshot.chat.lastMessagePreview,
    currentSelection: snapshot.chat.currentSelection,
    createdAt: snapshot.chat.createdAt,
    updatedAt: snapshot.chat.updatedAt,
  },
  projectId: "matrix-os",
  providerBinding: snapshot.chat.providerBinding,
};

function client(): CanonicalChatClient {
  return {
    list: vi.fn(async () => ({ items: [record] })),
    search: vi.fn(async () => ({ items: [record] })),
    getDetail: vi.fn(async () => ({
      record,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    })),
    create: vi.fn(),
    updateProject: vi.fn(),
    delete: vi.fn(),
    admitTurn: vi.fn(),
    cancelRun: vi.fn(),
    retryTurn: vi.fn(),
  } as CanonicalChatClient;
}

function resizeProjectChat(width: number) {
  const workspace = document.querySelector<HTMLElement>('[data-slot="canonical-chat-workspace"]');
  if (!workspace) throw new Error("Canonical Project Chat workspace did not render");
  const entry = {
    target: workspace,
    contentRect: { width },
  } as unknown as ResizeObserverEntry;
  for (const callback of resizeObserverCallbacks) {
    callback([entry], {} as ResizeObserver);
  }
}

describe("Project Chat narrow layout", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = WorkspaceResizeObserver;
  });

  beforeEach(() => {
    resizeObserverCallbacks.length = 0;
    useBoard.setState(useBoard.getInitialState(), true);
    useConnection.setState(useConnection.getInitialState(), true);
  });

  afterEach(cleanup);

  it("stacks the Project rail above an existing conversation at the OS View minimum width", async () => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        initialChatId={snapshot.chat.id}
        active
        catalog={providerCatalog}
      />,
    );

    await screen.findByRole("textbox", { name: "Reply to chat" });
    act(() => resizeProjectChat(440));

    const workspace = document.querySelector<HTMLElement>('[data-slot="canonical-chat-workspace"]');
    const rail = screen.getByRole("complementary", { name: "Project chats" });
    const composer = document.querySelector<HTMLElement>(
      '[data-slot="shared-chat-composer"] .prompt-card',
    );

    expect(workspace?.getAttribute("data-layout")).toBe("narrow");
    expect(workspace?.className).toContain("flex-col");
    expect(rail.getAttribute("data-layout")).toBe("narrow");
    expect(rail.className).toContain("w-full");
    expect(rail.className).toContain("border-b");
    expect(screen.getByRole("region", { name: "Messages" })).toBeTruthy();
    expect(composer?.getAttribute("data-layout")).toBe("narrow");
  });
});
