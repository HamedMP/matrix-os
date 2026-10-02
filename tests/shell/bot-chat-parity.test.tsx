// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatApp } from "../../shell/src/components/ChatApp.js";
import type { ChatAgentClient } from "../../packages/ui/src/chat-agents/client.js";
import { BotChatPanel } from "../../packages/ui/src/chat-agents/bots/BotChatPanel.js";

vi.mock("@clerk/nextjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clerk/nextjs")>()),
  useOrganization: () => ({ organization: null }),
  useAuth: () => ({ userId: null, sessionId: null }),
}));

afterEach(cleanup);

it("renders a direct bot's identity, pending interaction and authority from its saved Chat", async () => {
  const client = { bots: {
    directBot: vi.fn(async () => "bot_research1"),
    interactions: vi.fn(async () => [{ interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
      taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
      payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } }]),
    tasks: vi.fn(async () => [{ taskId: "task_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
      status: "waiting_person", revision: 1, updatedAt: "2026-09-28T12:00:00.000Z" }]),
    authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
    resolve: vi.fn(), revoke: vi.fn(), memory: vi.fn(),
  }, list: vi.fn(async () => ({ agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "automatic" }, recipeRef: { recipeId: "research", version: "1" } }] })) };
  render(<BotChatPanel chatId="chat_research" client={client as never} />);
  expect((await screen.findAllByText("Research Rabbit")).length).toBeGreaterThan(0);
  expect(await screen.findByText("Which company?")).toBeTruthy();
  expect(screen.getByText("Waiting for your answer")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Details" })).toBeTruthy();
});

it("keeps bot controls absent for a non-bot Chat", async () => {
  const client = { bots: { directBot: vi.fn(async () => null) } };
  render(<BotChatPanel chatId="chat_general" client={client as never} />);
  await waitFor(() => expect(client.bots.directBot).toHaveBeenCalledOnce());
  expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
});

it("keeps bot interactions visible when only the agent library request fails", async () => {
  const client = { bots: {
    directBot: vi.fn(async () => "bot_research1"),
    interactions: vi.fn(async () => [{ interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
      taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending",
      expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
      payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } }]),
    tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
      pendingInteractions: [], memory: { items: [] } })),
  }, list: vi.fn(async () => { throw new Error("library unavailable"); }) };
  render(<BotChatPanel chatId="chat_research" client={client as never} />);
  expect(await screen.findByText("Which company?")).toBeTruthy();
});

it("keeps the last valid bot controls visible when one status refresh fails", async () => {
  const interaction = { interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
    taskId: "task_abcdefgh", kind: "question", blocking: true, status: "pending", revision: 1,
    expiresAt: "2099-01-01T00:00:00.000Z",
    payload: { kind: "question", questions: [{ questionId: "target", header: "Target", question: "Which company?" }] } };
  const interactions = vi.fn().mockResolvedValueOnce([interaction]).mockRejectedValueOnce(new Error("temporary"));
  const client = { bots: {
    directBot: vi.fn(async () => "bot_research1"), interactions,
    tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
      pendingInteractions: [], memory: { items: [] } })),
  }, list: vi.fn(async () => ({ enabled: true, agents: [] })) };
  const { rerender } = render(<BotChatPanel chatId="chat_research" client={client as never} refreshKey={0} />);
  expect(await screen.findByText("Which company?")).toBeTruthy();
  rerender(<BotChatPanel chatId="chat_research" client={client as never} refreshKey={1} />);
  await waitFor(() => expect(interactions).toHaveBeenCalledTimes(2));
  expect(screen.getByText("Which company?")).toBeTruthy();
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
});

it("removes a consent link when its connection request is no longer pending", async () => {
  const interaction = { interactionId: "in_abcdefgh", chatId: "chat_research", agentId: "bot_research1",
    taskId: "task_abcdefgh", kind: "connect_request", blocking: true, status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
    payload: { kind: "connect_request", service: "gmail", access: ["read"], benefit: "Read inbox",
      connectRequestId: "cr_abcdefgh" } };
  const interactions = vi.fn().mockResolvedValueOnce([interaction]).mockResolvedValue([]);
  const client = { bots: {
    directBot: vi.fn(async () => "bot_research1"), interactions,
    tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [],
      pendingInteractions: [], memory: { items: [] } })),
    resolve: vi.fn(async () => ({ interaction: { interactionId: interaction.interactionId, status: "resolved", revision: 2 },
      connectUrl: "https://consent.example.test/start" })),
  }, list: vi.fn(async () => ({ enabled: true, agents: [] })) };
  const { rerender } = render(<BotChatPanel chatId="chat_research" client={client as never} refreshKey={0} />);
  fireEvent.click(await screen.findByRole("button", { name: "Connect" }));
  expect(await screen.findByRole("link", { name: "Continue connecting" })).toBeTruthy();
  rerender(<BotChatPanel chatId="chat_research" client={client as never} refreshKey={1} />);
  await waitFor(() => expect(interactions).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("link", { name: "Continue connecting" })).toBeNull());
});

for (const surface of ["Web Canvas", "Web Desktop"] as const) {
  it(`renders the shared bot identity, question, and remembered item in ${surface} Chat`, async () => {
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
      list: vi.fn(async () => ({ enabled: true, agents: [{ id: "bot_research1", name: "Research Rabbit", revision: 1, instructions: "Research source-backed briefs.", description: "Research", archived: false, createdAt: "2026-09-28T12:00:00.000Z", updatedAt: "2026-09-28T12:00:00.000Z", selection: { instanceId: "matrix_bot_default", model: "automatic" }, recipeRef: { recipeId: "research", version: "1" } }] })),
      search: vi.fn(async () => ({ enabled: true, resources: [] })),
    } as unknown as ChatAgentClient;

    render(<ChatApp messages={[]} sessionId="chat_research" busy={false} connected conversations={[]}
      onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={vi.fn()} agentClient={client} />);
    expect((await screen.findAllByText("Research Rabbit")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Which company?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(await screen.findByText("Keep briefs concise")).toBeTruthy();
  });
}

it("sends a verified direct bot Chat without an ordinary harness selection", async () => {
  const onSubmit = vi.fn(async () => true);
  const client = { bots: {
    directBot: vi.fn(async () => "bot_research1"), interactions: vi.fn(async () => []), tasks: vi.fn(async () => []),
    authority: vi.fn(async () => ({ agentId: "bot_research1", revision: 1, grants: [], connections: [], routines: [], pendingInteractions: [], memory: { items: [] } })),
  }, list: vi.fn(async () => ({ enabled: true, agents: [] })) } as unknown as ChatAgentClient;
  render(<ChatApp messages={[]} sessionId="chat_research" busy={false} connected conversations={[]}
    onNewChat={vi.fn()} onSwitchConversation={vi.fn()} onSubmit={onSubmit} agentClient={client} />);
  await screen.findByRole("button", { name: "Choose bot agent and model" });
  expect(screen.queryByText("Company drive context is not available in Bot chats.")).toBeNull();
  expect(screen.queryByText("Choose Claude Code to use company drive context.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Add company drive context" })).toBeNull();
  fireEvent.change(screen.getByRole("textbox", { name: /message/i }), { target: { value: "Check the pages" } });
  fireEvent.click(screen.getByRole("button", { name: /send/i }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("Check the pages", undefined, expect.objectContaining({
    instanceId: "matrix_bot_default", model: "auto", interactionMode: "default", permissionMode: "default",
  })));
});
it('retains authenticated access details when only Bot metadata cannot be read and retries it',async()=>{
 const client={bots:{directBot:vi.fn(async()=> 'bot_research1'),interactions:vi.fn(async()=>[]),tasks:vi.fn(async()=>[]),
  authority:vi.fn(async()=>({agentId:'bot_research1',revision:1,grants:[],connections:[],routines:[],pendingInteractions:[],memory:{items:[{itemId:'mem_abcdefgh',kind:'preference',scope:'bot',content:'Keep briefs concise',source:{at:'2026-09-28T12:00:00.000Z'},confirmed:true,revision:1}]}})),
 },list:vi.fn(async()=>{throw new Error('metadata unavailable');})};
 render(<BotChatPanel chatId='chat_research' client={client as never}/>);
 await waitFor(()=>expect(client.list).toHaveBeenCalledOnce());fireEvent.click(screen.getByRole('button',{name:'Details'}));
 expect(await screen.findByText('Keep briefs concise')).toBeTruthy();expect(screen.getByText('Bot instructions are unavailable.')).toBeTruthy();
 expect((screen.getByRole('button',{name:'Edit bot'}) as HTMLButtonElement).disabled).toBe(true);
 expect(screen.queryByRole('combobox',{name:'Bot model'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Retry bot details'}));
 await waitFor(()=>expect(client.list).toHaveBeenCalledTimes(2));
});
