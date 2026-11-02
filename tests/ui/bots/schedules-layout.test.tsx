// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ChatAgentsContent } from "../../../packages/ui/src/chat-agents/ChatAgentsContent.js";
import { ChatAgentsRailSection } from "../../../packages/ui/src/chat-agents/ChatAgentsRailSection.js";
import { ChatAgentsWorkspace, useChatAgentsNavigation } from "../../../packages/ui/src/chat-agents/ChatAgentsNavigation.js";
import { ScheduleCenter } from "../../../packages/ui/src/chat-agents/bots/ScheduleCenter.js";
import type { ChatAgentClient } from "../../../packages/ui/src/chat-agents/client.js";
import { clientFixture, saved } from "../../desktop/chat-agents-fixture";

afterEach(cleanup);
const routine = { routineId: "rt_0123456789abcdef01234567", botId: "bot_fixture", chatId: "chat_exact_owner",
  proposal: {name: "Morning brief", prompt: "Write a private brief.", schedule: {kind: "interval", everyMs: 3600000},
    selection: {instanceId: "matrix_chatgpt_plan", model: "gpt-model"}, authorizedEffects: ["read"]},
  computerId: "My Computer", status: "active", revision: 1, nextFireAt: "2099-01-01T10:00:00.000Z",
  targetAvailable: true, sourceAvailable: true, requiresReview: false, lastFire: null } as const;
function setup(overrides = {}) {
  const row = {...routine, ...overrides};
  const routines = {list: vi.fn(async () => ({items: [row], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine: row, history: [{fireId: "fire_private_history", scheduledFor: "2026-11-02T01:00:00Z", status: "completed", attempts: 1}]})),
    control: vi.fn(), review: vi.fn()};
  return {routines, client: {...clientFixture(), bots: {routines, recipes: vi.fn(async () => [])}} as unknown as ChatAgentClient};
}
it("replaces the list with one selected detail and returns to the saved list", async () => {
  const {client} = setup();
  render(<ScheduleCenter client={client} onClose={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  await screen.findByRole("region", {name: "Schedule details"});
  expect(screen.queryByRole("button", {name: "View Morning brief"})).toBeNull();
  expect(screen.getAllByText("Write a private brief.")).toHaveLength(1);
  expect(screen.getAllByRole("button", {name: "Pause Morning brief"})).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", {name: "Back to schedules"}));
  expect(screen.getByRole("button", {name: "View Morning brief"})).toBeTruthy();
  expect(screen.queryByRole("region", {name: "Schedule details"})).toBeNull();
});
it("keeps execution history out of Schedules and opens the exact owning Chat", async () => {
  const {client} = setup(), open = vi.fn(), close = vi.fn();
  render(<ScheduleCenter client={client} onClose={close} onOpenBotChat={open}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  await screen.findByRole("region", {name: "Schedule details"});
  expect(screen.queryByText("Recent runs")).toBeNull();
  expect(screen.queryByText(/1 attempt/)).toBeNull();
  fireEvent.click(screen.getByRole("button", {name: "Open task Chat"}));
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("chat_exact_owner"));
  expect(close).toHaveBeenCalledTimes(1);
});
it("offers new-schedule navigation without creating or activating work", async () => {
  const {client, routines} = setup(), start = vi.fn();
  render(<ScheduleCenter client={client} onClose={vi.fn()} onNewSchedule={start}/>);
  fireEvent.click(await screen.findByRole("button", {name: "New schedule"}));
  expect(start).toHaveBeenCalledTimes(1);
  expect(routines.control).not.toHaveBeenCalled();
  expect(routines.review).not.toHaveBeenCalled();
});
it("retains details and shows a safe error if opening the saved Chat fails", async () => {
  const {client} = setup(), close = vi.fn();
  render(<ScheduleCenter client={client} onClose={close} onOpenBotChat={vi.fn().mockRejectedValue(new Error("secret /home/private"))}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  fireEvent.click(await screen.findByRole("button", {name: "Open task Chat"}));
  expect((await screen.findByRole("alert")).textContent).not.toMatch(/secret|home/);
  expect(screen.getByRole("region", {name: "Schedule details"})).toBeTruthy();
  expect(close).not.toHaveBeenCalled();
});
it("keeps read-only Chat navigation available when its Bot execution target is unavailable", async () => {
  const {client} = setup({targetAvailable: false});
  render(<ScheduleCenter client={client} onClose={vi.fn()} onOpenBotChat={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", {name: "View Morning brief"}));
  await screen.findByRole("region", {name: "Schedule details"});
  expect(screen.getByRole("button", {name: "Open task Chat"})).toBeTruthy();
});

it("places Schedules above the Agents heading in the shared Chat sidebar", async () => {
  const {client} = setup();
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/></ChatAgentsWorkspace>);
  const schedules = await screen.findByRole("button", {name: "Schedules"});
  const agents = screen.getByRole("button", {name: "Agents"});
  expect(schedules.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(schedules.classList.contains("matrix-chat-agents-heading")).toBe(true);
});

it("routes New schedule through existing Bot selection and does not turn ordinary Agents into a schedule wizard", async () => {
  const {client, routines} = setup();
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/><ChatAgentsContent client={client} scopeKey="owner"><p>Retained transcript</p></ChatAgentsContent></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", {name: "Schedules"}));
  fireEvent.click(await screen.findByRole("button", {name: "New schedule"}));
  await screen.findByText(/Choose a private Bot, then describe/);
  expect(screen.queryByRole("region", {name: "Schedules"})).toBeNull();
  expect(screen.getByText("Retained transcript").closest("[hidden]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Agents"}));
  expect(screen.queryByText(/Choose a private Bot, then describe/)).toBeNull();
  expect(routines.control).not.toHaveBeenCalled();
  expect(routines.review).not.toHaveBeenCalled();
});

it("preserves Chat creation and setup recovery capabilities when starting a schedule", async () => {
  const {client} = setup(), setupProvider = vi.fn(), start = vi.fn();
  let capabilities: ReturnType<typeof useChatAgentsNavigation>;
  function Inspect() {capabilities = useChatAgentsNavigation(); return null;}
  render(<ChatAgentsWorkspace><Inspect/><ChatAgentsRailSection client={client} onSetup={setupProvider} onStartChat={start}/>
    <ChatAgentsContent client={client} scopeKey="owner"><p>Chat</p></ChatAgentsContent></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", {name: "Schedules"}));
  fireEvent.click(await screen.findByRole("button", {name: "New schedule"}));
  await screen.findByText(/Choose a private Bot/);
  capabilities!.opened!.onSetup!();
  capabilities!.opened!.onStartChat!("Plan a task");
  expect(setupProvider).toHaveBeenCalledTimes(1);
  expect(start).toHaveBeenCalledExactlyOnceWith("Plan a task");
});

it("selects an existing Bot for a new schedule by opening its Chat, never its editor", async () => {
  const {client} = setup(), open = vi.fn();
  vi.spyOn(client, "list").mockResolvedValue({enabled: true, agents: [{...saved, recipeRef: {recipeId: "writer", version: "1"}}]});
  const ensure = vi.fn(async () => "chat_existing_bot");
  client.bots!.ensureDirectChat = ensure;
  render(<ChatAgentsWorkspace><ChatAgentsRailSection client={client}/><ChatAgentsContent client={client} scopeKey="owner" onOpenBotChat={open}><p>Existing transcript</p></ChatAgentsContent></ChatAgentsWorkspace>);
  fireEvent.click(await screen.findByRole("button", {name: "Schedules"}));
  fireEvent.click(await screen.findByRole("button", {name: "New schedule"}));
  fireEvent.click(await screen.findByRole("button", {name: "Schedule with Meeting helper"}));
  await waitFor(() => expect(open).toHaveBeenCalledExactlyOnceWith("chat_existing_bot"));
  expect(ensure).toHaveBeenCalledExactlyOnceWith(saved.id);
  expect(screen.queryByRole("dialog", {name: "Edit Agent"})).toBeNull();
  expect(client.update).not.toHaveBeenCalled();
});
