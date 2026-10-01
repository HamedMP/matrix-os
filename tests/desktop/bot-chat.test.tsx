// @vitest-environment jsdom
import React from "react";
import { setSharedComposerText } from "./shared-chat-composer-test-utils";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import type { ChatAgentClient } from "@matrix-os/ui";
import type { CanonicalChatEventSource, CanonicalChatInvalidation } from "@matrix-os/ui";
import { createCanonicalChatWorkspaceClient, providerCatalog, snapshot } from "./canonical-chat-workspace-test-utils";

beforeAll(() => {
  globalThis.ResizeObserver = class implements ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(cleanup);

describe("Electron Desktop bot Chat", () => {
  it("shows the direct bot, its pending question, and remembered parts in Chat", async () => {
    const client = createCanonicalChatWorkspaceClient();
    client.agents = {
      bots: {
        directBot: vi.fn(async () => "bot_research1"),
        interactions: vi.fn(async () => [{
          interactionId: "in_abcdefgh", chatId: snapshot.chat.id, agentId: "bot_research1",
          taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
          expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
          payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] },
        }]),
        tasks: vi.fn(async () => []),
        authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
          pendingInteractions: [], memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot",
            content: "Keep briefs concise", source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: true, revision: 1 }] } })),
      },
      list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit" }] })),
    } as unknown as ChatAgentClient;

    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
      initialView="conversation" active catalog={providerCatalog} />);

    expect(await screen.findByText("Research Rabbit")).toBeTruthy();
    expect(await screen.findByText("Which company?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show bot authority" }));
    expect(await screen.findByText("Keep briefs concise")).toBeTruthy();
    await waitFor(() => expect(client.agents!.bots!.directBot).toHaveBeenCalledWith(snapshot.chat.id));
  });

  it("uses DELETE for grant revocation", async () => {
    const remove = vi.fn(async () => ({ grantId: "gr_abcdefgh", revokedAt: "2026-09-28T12:00:00.000Z" }));
    const patch = vi.fn();
    const client = createCanonicalChatClient({ get: vi.fn(), post: vi.fn(), patch, delete: remove } as unknown as ApiClient);
    await client.agents!.bots!.revoke("bot_research1", "gr_abcdefgh");
    expect(remove).toHaveBeenCalledWith("/api/chat-agents/bot_research1/grants/gr_abcdefgh");
    expect(patch).not.toHaveBeenCalled();
  });

  it("refreshes bot controls on bot events without a chat revision change", async () => {
    const client = createCanonicalChatWorkspaceClient();
    const interactions = vi.fn(async () => []);
    client.agents = { bots: {
      directBot: vi.fn(async () => "bot_research1"), interactions,
      tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
        grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
    }, list: vi.fn(async () => ({ enabled: true, agents: [] })) } as unknown as ChatAgentClient;
    const listeners = new Set<(event: CanonicalChatInvalidation) => void>();
    const eventSource = { subscribe(listener: (event: CanonicalChatInvalidation) => void) {
      listeners.add(listener); return { dispose: () => { listeners.delete(listener); } };
    } } as CanonicalChatEventSource;
    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
      initialView="conversation" active catalog={providerCatalog} eventSource={eventSource} />);
    await waitFor(() => expect(interactions).toHaveBeenCalledTimes(1));
    act(() => { for (const listener of listeners) listener({ type: "chat.changed", chatId: snapshot.chat.id,
      cursor: 10, revision: snapshot.chat.revision, eventType: "bot.interaction.created" }); });
    await waitFor(() => expect(interactions).toHaveBeenCalledTimes(2));
  });

  it("resolves a question and revokes a grant from rendered controls", async () => {
    const client = createCanonicalChatWorkspaceClient();
    const interactions = vi.fn(async () => [{ interactionId: "in_abcdefgh", chatId: snapshot.chat.id,
      agentId: "bot_research1", taskId: "task_abcdefgh", kind: "question" as const, blocking: true,
      status: "pending" as const, expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
      payload: { kind: "question" as const, questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } }]);
    const resolve = vi.fn(async () => ({ interaction: { interactionId: "in_abcdefgh", status: "resolved", revision: 2 } }));
    const revoke = vi.fn(async () => undefined);
    client.agents = { bots: { directBot: vi.fn(async () => "bot_research1"), interactions,
      tasks: vi.fn(async () => []), resolve, revoke,
      authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
        grants: [{ grantId: "gr_abcdefgh", service: "gmail", accountLabel: "Work", effects: ["read"], audience: "direct", expiresAt: null }],
        connections: [{ service: "gmail", state: "granted" }], routines: [], pendingInteractions: [], memory: { items: [] } })),
    }, list: vi.fn(async () => ({ enabled: true, agents: [] })) } as unknown as ChatAgentClient;
    render(<CanonicalChatWorkspace client={client} projectId="matrix-os" initialChatId={snapshot.chat.id}
      initialView="conversation" active catalog={providerCatalog} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Answer Target" }), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Answer" }));
    await waitFor(() => expect(resolve).toHaveBeenCalledWith(snapshot.chat.id, "in_abcdefgh",
      { kind: "question", baseRevision: 1, structuredAnswers: { target: ["Acme"] } }));
    await waitFor(() => expect(interactions.mock.calls.length).toBeGreaterThan(1));
    fireEvent.click(screen.getByRole("button", { name: "Show bot authority" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke Work" }));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith("bot_research1", "gr_abcdefgh"));
  });
});

it("admits a direct bot turn when the ordinary provider catalog is empty", async () => {
  const client = createCanonicalChatWorkspaceClient();
  client.agents = { bots: { directBot: vi.fn(async () => "bot_research1"), interactions: vi.fn(async () => []),
    tasks: vi.fn(async () => []), authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1,
      grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })) },
    list: vi.fn(async () => ({ enabled: true, agents: [] })) } as unknown as ChatAgentClient;
  render(<CanonicalChatWorkspace client={client} initialChatId={snapshot.chat.id} initialView="conversation"
    active catalog={{ ...providerCatalog, instances: [] }} />);
  await screen.findByText("Your bot's Chat");
  expect(screen.getByText("Runtime: Pi · Checking bot model…")).toBeTruthy();
  const composer = screen.getByRole("textbox", { name: "Reply to chat" });
  await setSharedComposerText(composer, "Check the pages");
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  await waitFor(() => expect(client.admitTurn).toHaveBeenCalledWith(snapshot.chat.id,
    expect.objectContaining({ selection: { instanceId: "matrix_bot_default", model: "auto" }, interactionMode: "default", permissionMode: "default" }), expect.anything()));
});
