// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CanonicalChatWorkspace } from "@desktop/renderer/src/features/chat/CanonicalChatWorkspace";
import { createCanonicalChatClient } from "@desktop/renderer/src/lib/canonical-chat-client";
import type { ApiClient } from "@desktop/renderer/src/lib/api";
import type { ChatAgentClient } from "@matrix-os/ui";
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
});
