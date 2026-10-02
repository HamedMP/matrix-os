// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";

afterEach(cleanup);

vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ getToken: async () => null, orgId: null }),
}));

it("shows bot identity, questions, and memory in Web Mobile Chat", async () => {
  const client = {
    bots: {
      directBot: vi.fn(async () => "bot_research1"),
      interactions: vi.fn(async () => [{ interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
        taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
        expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
        payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } }]),
      tasks: vi.fn(async () => []),
      authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
        pendingInteractions: [], memory: { items: [{ itemId: "mem_abcdefgh", kind: "preference", scope: "bot",
          content: "Keep briefs concise", source: { at: "2026-09-28T12:00:00.000Z" }, confirmed: true, revision: 1 }] } })),
    },
    list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit" }] })),
  } as unknown as ChatAgentClient;

  render(<ChatApp mobile messages={[]} sessionId="chat_research" busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client} />);

  expect(await screen.findByText("Research Rabbit")).toBeTruthy();
  expect(await screen.findByText("Which company?")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Show bot authority" }));
  expect(await screen.findByText("Keep briefs concise")).toBeTruthy();
});
