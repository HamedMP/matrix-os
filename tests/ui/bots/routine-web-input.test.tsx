// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ChatApp } from "../../../shell/src/components/ChatApp";
import { createBotRoutineClient } from "../../../packages/ui/src/chat-agents/bots/routine-client";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture";
import type { ChatMessage } from "../../../shell/src/lib/chat";
import { routineMessageFixture } from "../../helpers/routine-message-fixture";
import { createCanonicalProviderCatalogFixture } from "../../contracts/fixtures/canonical-chat";

vi.mock("@clerk/nextjs", async original => ({
  ...await original<typeof import("@clerk/nextjs")>(),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));
vi.mock("../../../shell/src/components/chat-provider-onboarding", () => ({
  ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(createCanonicalProviderCatalogFixture())));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(["completed", "failed"] as const)("keeps the Agent result and human input for a linked %s scheduled occurrence", async status => {
  const { routine, history } = routineMessageFixture();
  const at = Date.parse(history[0]!.scheduledFor);
  const fire = { ...history[0]!, status, attempts: 1 };
  const prompt = "Prepare the weekly digest. ".repeat(12).trim();
  const messages: ChatMessage[] = [
    { id: "scheduled_input", role: "user", content: prompt, timestamp: at,
      metadata: { routineRequestId: `req_routine_${fire.fireId}` } },
    { id: "scheduled_reply", role: "assistant", content: "Here’s the weekly digest.", timestamp: at + 1 },
    { id: "manual_message", role: "user", content: prompt, timestamp: at + 2 },
  ];

  const bot = clientFixture();
  bot.list.mockResolvedValue({ enabled: true, agents: [saved] });
  const row = { ...routine, lastFire: fire };
  const routines = createBotRoutineClient(async path => {
    if (path === `/api/bot-routines/${routine.routineId}`) return { routine: row, history: [fire] };
    if (path === "/api/bot-routines" || path.startsWith("/api/bot-routines?")) return { items: [row], pending: [], nextCursor: null };
    throw new Error("Unexpected routine read");
  });
  const agentClient = { ...bot, bots: { directBot: async () => saved.id,
    routines, interactions: async () => [], tasks: async () => [], authority: async () => null } } as unknown as ChatAgentClient;
  render(<ChatApp busy={false} connected conversations={[]} messages={messages} sessionId={routine.chatId} agentClient={agentClient}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()}/>);
  await waitFor(() => expect(screen.getAllByText(prompt)).toHaveLength(1));
  expect(screen.getByText("Here’s the weekly digest.")).toBeTruthy();
  expect(screen.queryByText("Sent by scheduled task")).toBeNull();
  expect(Boolean(screen.queryByText("Scheduled task failed"))).toBe(status === "failed");
  expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
});
