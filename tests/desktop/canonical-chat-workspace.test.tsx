// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    await waitFor(() => expect(screen.getByRole("button", { name: snapshot.chat.title })).toBeTruthy());
    if (projectId === null) fireEvent.click(screen.getByRole("button", { name: snapshot.chat.title }));
    const surface = await screen.findByRole("region", { name: projectId ? "Project Chat" : "Global Chat" });
    expect(surface.getAttribute("data-chat-context")).toBe(projectId ? "project" : "global");
    expect(surface.querySelector('[data-slot="shared-chat-composer"]')).toBeTruthy();
  });

  it("keeps the global Figma list full-width and exposes the MAT-476 attachment control", async () => {
    const { container } = render(
      <CanonicalChatWorkspace
        client={client()}
        projectId={null}
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Chats" })).toBeTruthy();
    expect(container.querySelector('aside[aria-label="Global chats"]')).toBeNull();
    expect(screen.getByRole("button", { name: snapshot.chat.title })).toBeTruthy();
    expect(container.querySelector("[data-chat-index-content]")?.className).toContain("max-w-[1020px]");
    expect(container.querySelector("[data-chat-index-list]")?.className).toContain("pb-4");
    expect(screen.getByRole("button", { name: snapshot.chat.title }).className).toContain("last:border-b-0");

    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(await screen.findByRole("button", { name: "Add files and more" })).toBeTruthy();
  });

  it("reconciles a stale provider-default selection with the live Gateway catalog", async () => {
    const staleRecord = {
      ...record,
      chat: {
        ...record.chat,
        currentSelection: {
          instanceId: "codex_fixture",
          model: "provider-default",
        },
      },
    };
    const staleClient = client();
    vi.mocked(staleClient.list).mockResolvedValue({ items: [staleRecord] });
    vi.mocked(staleClient.getDetail).mockResolvedValue({
      record: staleRecord,
      messages: snapshot.messages,
      turns: snapshot.turns,
      runs: snapshot.runs,
      activities: snapshot.activities,
    });

    render(
      <CanonicalChatWorkspace
        client={staleClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );

    const modelPicker = await screen.findByRole("button", { name: "Choose model and provider" });
    await waitFor(() => expect(modelPicker.textContent).toContain("GPT-5.6-Sol"));
    expect(modelPicker.textContent).not.toContain("Provider default");
  });

  it("shows the current Project on the shared composer before a Chat exists", async () => {
    const emptyClient = client();
    vi.mocked(emptyClient.list).mockResolvedValue({ items: [] });

    render(
      <CanonicalChatWorkspace
        client={emptyClient}
        projectId="matrix-os"
        projectLabel="Matrix OS"
        active
        catalog={providerCatalog}
      />,
    );

    expect(await screen.findByRole("button", { name: "Project Matrix OS" })).toBeTruthy();
  });
});
