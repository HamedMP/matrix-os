// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, renderHook, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatAgentsPanel } from "../../../packages/ui/src/chat-agents/ChatAgentsEntry.js";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsWorkspace } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { useBotMentionNavigation } from "../../../packages/ui/src/chat-agents/bots/use-bot-mention-navigation.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture.js";
import type { BotClient } from "../../../packages/ui/src/chat-agents/bots/client.js";
import { resolveDailyBriefChat } from "../../../packages/ui/src/chat-agents/bots/daily-brief-navigation.js";
import type { ChatAgent } from "@matrix-os/contracts";

afterEach(cleanup);
HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
const legacy = { ...saved, instructions: "Prepare today's daily brief from connected email and calendar sources.", name: "Renamed brief", recipe: { skills: ["matrix-personal-daily-brief", "matrix-integrations"], integrations: [{ service: "gmail" }, { service: "google_calendar" }], output: "Owner-edited output" } };
const recipe = { recipeId: "personal-daily-brief", version: "2026-09-27.1", name: "Daily Brief", description: "Read calendar and inbox", output: "Brief", integrations: [], capabilities: [] };
function fixture(agents: ChatAgent[] = [legacy]) {
  const client = clientFixture({ matrix: true });
  let activeAgents = [...agents];
  client.list.mockImplementation(async () => ({ enabled: true, agents: activeAgents }));
  const bots = {
    directChat: vi.fn(async (id: string) => activeAgents.some(agent => agent.id === id && agent.recipeRef?.recipeId === recipe.recipeId) ? "chat_dailybrief" : null),
    recipes: vi.fn(async () => [recipe]),
    instantiate: vi.fn(async () => {
      const agent = { ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } };
      activeAgents = [...activeAgents.filter(candidate => candidate.id !== agent.id), agent];
      return { chatId: "chat_dailybrief", agent };
    }),
  };
  return { ...client, bots: bots as unknown as BotClient, calls: bots };
}
it("opens Daily Brief setup without creating, sending or opening a Chat before explicit confirmation", async () => {
  const client = fixture(), open = vi.fn(), start = vi.fn();
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} onStartChat={start} />);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  await screen.findByRole("dialog", { name: "Set up Personal Daily Brief" });
  expect((screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value).toBe("Personal Daily Brief");
  expect(screen.getByRole("combobox", { name: "Bot model" }).textContent).toContain("Matrix AI");
  expect(screen.queryByRole("option", { name: /Codex/ })).toBeNull();
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(client.create).not.toHaveBeenCalled();
});
it("creates a deliberate new Daily Brief even when an existing recipe Bot is saved", async () => {
  const bot = { ...legacy, id: "bot_canonicalbrief", name: "My private briefing", recipeRef: { recipeId: recipe.recipeId, version: "older" } };
  const client = fixture([legacy, bot]), open = vi.fn();
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  await screen.findByRole("dialog", { name: "Set up Personal Daily Brief" });
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Another briefing" } });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_dailybrief"));
  expect(client.calls.instantiate).toHaveBeenCalledWith({ recipe: { recipeId: recipe.recipeId, version: recipe.version }, clientRequestId: expect.stringMatching(/^req_[a-f0-9]{32}$/), name: "Another briefing", selection: { instanceId: "matrix_pi_default", model: "sonnet" } });
  expect(client.calls.directChat).not.toHaveBeenCalled(); expect(client.create).not.toHaveBeenCalled(); expect(client.update).not.toHaveBeenCalled();
});
it("redirects the legacy built-in skill entry from the sidebar while preserving its owner definition", async () => {
  const client = fixture(), open = vi.fn(), start = vi.fn();
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client} onOpenBotChat={open} onStartChat={start} /></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", { name: "Chat with Renamed brief" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_dailybrief"));
  expect(start).not.toHaveBeenCalled(); expect(client.update).not.toHaveBeenCalled();
});
it("routes a legacy Daily Brief mention with its draft into the persistent Bot rather than attaching a custom Agent", async () => {
  const client = fixture(), open = vi.fn(async () => true), insert = vi.fn();
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open));
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Keep my draft", insert); });
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_dailybrief", "Keep my draft"));
  expect(insert).not.toHaveBeenCalled(); expect(client.update).not.toHaveBeenCalled();
});
it("never classifies a custom Agent as Daily Brief from its name alone", async () => {
  const client = fixture([{ ...saved, name: "Personal Daily Brief" }]), open = vi.fn(), insert = vi.fn();
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open));
  act(() => { result.current.select({ kind: "agent", id: saved.id, label: "Personal Daily Brief" }, "Draft", insert); });
  await waitFor(() => expect(insert).toHaveBeenCalledOnce());
  expect(open).not.toHaveBeenCalled(); expect(client.calls.instantiate).not.toHaveBeenCalled();
});
it("preserves the draft and avoids inline fallback when Daily Brief creation fails", async () => {
  const client = fixture(), open = vi.fn(), insert = vi.fn();
  client.calls.instantiate.mockRejectedValue(new Error("unavailable"));
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open));
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Draft", insert); });
  await waitFor(() => expect(result.current.error).toMatch(/draft is preserved/));
  expect(open).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});
it("replays the same fixed creation payload after a failed entry instead of making another Bot", async () => {
  const client = fixture();
  client.calls.instantiate.mockRejectedValueOnce(new Error("unavailable"));
  await expect(resolveDailyBriefChat(client)).rejects.toThrow();
  await expect(resolveDailyBriefChat(client)).resolves.toBe("chat_dailybrief");
  expect(client.calls.instantiate.mock.calls[0]).toEqual(client.calls.instantiate.mock.calls[1]);
  expect(client.update).not.toHaveBeenCalled();
});
it("does not replace a canonical Bot whose authenticated binding is temporarily missing", async () => {
  const client = fixture([{ ...saved, recipeRef: { recipeId: recipe.recipeId, version: "older" } }]);
  client.calls.directChat.mockResolvedValue(null);
  await expect(resolveDailyBriefChat(client)).rejects.toThrow("Missing bot binding");
  expect(client.calls.recipes).not.toHaveBeenCalled(); expect(client.calls.instantiate).not.toHaveBeenCalled();
});
it("does not create a Bot after a source change during recipe lookup", async () => {
  const client = fixture(); let finish!: (value: typeof recipe[]) => void;
  client.calls.recipes.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const open = vi.fn(), insert = vi.fn();
  const { result, rerender } = renderHook(({ scope }) => useBotMentionNavigation(client, scope, open), { initialProps: { scope: "source" } });
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Draft", insert); });
  await waitFor(() => expect(client.calls.recipes).toHaveBeenCalledOnce());
  rerender({ scope: "other" });
  await act(async () => { finish([recipe]); });
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});
it("preserves attachments without creating a Bot for a blocked legacy mention", async () => {
  const client = fixture(); const open = vi.fn(), insert = vi.fn();
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open, "Keep attached files"));
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Draft", insert); });
  await waitFor(() => expect(result.current.error).toBe("Keep attached files"));
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(insert).not.toHaveBeenCalled();
});
it("renders legacy and ordinary saved cards with the same full-width settings interaction", async () => {
  const client = fixture([legacy, { ...saved, id: "bot_othercustom" }]), open = vi.fn();
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} />);
  const legacyRow = await screen.findByRole("button", { name: `Edit ${legacy.name}` });
  const ordinaryRow = screen.getByRole("button", { name: `Edit ${saved.name}` });
  expect(legacyRow.className).toBe(ordinaryRow.className);
  expect(legacyRow.textContent).toContain("Own Chat");
  expect(ordinaryRow.textContent).toContain(`@${saved.name}`);
  expect(legacyRow.parentElement).toBe(ordinaryRow.parentElement);
  expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  expect(screen.queryByRole("button", { name: `Open ${legacy.name} bot` })).toBeNull();
  fireEvent.click(legacyRow);
  expect((screen.getByRole("textbox", { name: "Instructions" }) as HTMLTextAreaElement).value).toBe(legacy.instructions);
  expect(client.calls.instantiate).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled(); expect(client.update).not.toHaveBeenCalled();
});

it("keeps a deliberately customized two-skill specialist inline instead of replacing its instructions", async () => {
  const client = fixture([{ ...legacy, instructions: "Only summarize my investment research notes." }]), open = vi.fn(), insert = vi.fn();
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open));
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Draft", insert); });
  await waitFor(() => expect(insert).toHaveBeenCalledOnce());
  expect(open).not.toHaveBeenCalled(); expect(client.calls.instantiate).not.toHaveBeenCalled();
});

it("does not reopen an archived Bot returned by a stable creation replay", async () => {
  const client = fixture();
  client.calls.instantiate.mockResolvedValue({ chatId: "chat_archived", agent: { ...saved, archived: true, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } } });
  await expect(resolveDailyBriefChat(client)).rejects.toThrow();
  expect(client.calls.directChat).not.toHaveBeenCalled();
});
it("does not navigate a newly created Bot whose direct binding is missing", async () => {
  const client = fixture();
  client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } }] });
  client.calls.directChat.mockResolvedValue(null);
  await expect(resolveDailyBriefChat(client)).rejects.toThrow("Missing bot binding");
});

it("does not accept a creation replay with a different active recipe identity", async () => {
  const client = fixture();
  client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockResolvedValue({ enabled: true, agents: [{ ...saved, recipeRef: { recipeId: "writing-bot", version: recipe.version } }] });
  await expect(resolveDailyBriefChat(client)).rejects.toThrow("Daily Brief is not active");
  expect(client.calls.directChat).not.toHaveBeenCalled();
});
it("does not open the created Bot after navigation changes during active readback", async () => {
  const client = fixture(); let current = true;
  client.list.mockResolvedValueOnce({ enabled: true, agents: [] }).mockImplementationOnce(async () => {
    current = false;
    return { enabled: true, agents: [{ ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } }] };
  });
  await expect(resolveDailyBriefChat(client, () => current)).resolves.toBeNull();
  expect(client.calls.directChat).not.toHaveBeenCalled();
});
it("preserves the source text when a legacy Daily Brief target has its own draft", async () => {
  const client = fixture(), open = vi.fn(async () => false), insert = vi.fn();
  const { result } = renderHook(() => useBotMentionNavigation(client, "source", open));
  act(() => { result.current.select({ kind: "agent", id: legacy.id, label: legacy.name }, "Draft remains", insert); });
  await waitFor(() => expect(result.current.notice).toMatch(/text is still in the original Chat/));
  expect(open).toHaveBeenCalledWith("chat_dailybrief", "Draft remains");
  expect(insert).not.toHaveBeenCalled();
});

it("retries a failed explicit Daily Brief creation with the same operation and payload", async () => {
  const client = fixture(), open = vi.fn(); client.calls.instantiate.mockRejectedValueOnce(new Error("unavailable"));
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  await screen.findByRole("dialog", { name: "Set up Personal Daily Brief" });
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await screen.findByText("Bot could not be created. Try again.");
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(open).toHaveBeenCalledWith("chat_dailybrief"));
  expect(client.calls.instantiate.mock.calls[0]).toEqual(client.calls.instantiate.mock.calls[1]);
});

it("uses a fresh operation for a separately confirmed Daily Brief creation intent", async () => {
  const client = fixture(), open = vi.fn();
  client.calls.instantiate.mockRejectedValue(new Error("unavailable"));
  render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await screen.findByText("Bot could not be created. Try again.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Personal Daily Brief" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(client.calls.instantiate).toHaveBeenCalledTimes(2));
  expect(client.calls.instantiate.mock.calls[0]![0].clientRequestId).not.toBe(client.calls.instantiate.mock.calls[1]![0].clientRequestId);
  expect(open).not.toHaveBeenCalled();
});
it("clears an old-owner Daily Brief setup and suppresses its pending completion on client change", async () => {
  const client = fixture(), next = fixture(), open = vi.fn();
  let finish!: (value: Awaited<ReturnType<typeof client.calls.instantiate>>) => void;
  client.calls.instantiate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(<ChatAgentsPanel client={client} onClose={vi.fn()} onOpenBotChat={open} />);
  fireEvent.click(await screen.findByRole("button", { name: "Personal Daily Brief" }));
  fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
  await waitFor(() => expect(client.calls.instantiate).toHaveBeenCalledOnce());
  rerender(<ChatAgentsPanel client={next} onClose={vi.fn()} onOpenBotChat={open} />);
  expect(screen.queryByRole("dialog", { name: "Set up Personal Daily Brief" })).toBeNull();
  await act(async () => { finish({ chatId: "chat_old_owner", agent: { ...saved, recipeRef: { recipeId: recipe.recipeId, version: recipe.version } } }); });
  expect(open).not.toHaveBeenCalled();
  expect(next.calls.instantiate).not.toHaveBeenCalled();
});
