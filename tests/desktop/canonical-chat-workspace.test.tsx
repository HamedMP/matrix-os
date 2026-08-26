// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { CanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatFixture } from "../contracts/fixtures/canonical-chat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { snapshot, providerCatalog } = createCanonicalChatFixture("completed");
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
    admitTurn: vi.fn(),
    cancelRun: vi.fn(),
    retryTurn: vi.fn(),
  } as CanonicalChatClient;
}

describe("CanonicalChatWorkspace", () => {
  beforeAll(() => {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as typeof ResizeObserver;
  });

  afterEach(cleanup);

  it.each([
    ["global", null, undefined],
    ["project", "matrix-os", "Matrix OS"],
  ] as const)("renders the same controller and shared surface for %s", async (_name, projectId, projectLabel) => {
    render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={projectId}
        projectLabel={projectLabel}
        active
        catalog={providerCatalog}
      />,
    );

    const surface = await screen.findByRole("region", { name: projectId ? "Project Chat" : "Global Chat" });
    await waitFor(() => expect(screen.getByRole("button", { name: snapshot.chat.title })).toBeTruthy());
    expect(surface.getAttribute("data-chat-context")).toBe(projectId ? "project" : "global");
    expect(surface.querySelector('[data-slot="shared-chat-composer"]')).toBeTruthy();
  });
});
