// @vitest-environment jsdom
import React from "react";
import {afterEach, expect, it, vi} from "vitest";
import {cleanup, fireEvent, render, screen} from "@testing-library/react";
import {RoutineChatHistory} from "../../../packages/ui/src/chat-agents/bots/RoutineChatHistory.js";
import {act, waitFor} from "@testing-library/react";
import type {BotRoutineClient} from "../../../packages/ui/src/chat-agents/bots/routine-client.js";
import {BotChatPanel} from "../../../packages/ui/src/chat-agents/bots/BotChatPanel.js";
import type {ChatAgentClient} from "../../../packages/ui/src/chat-agents/client.js";
import {clientFixture, saved} from "../../desktop/chat-agents-fixture";

afterEach(cleanup);
it.each([true, false])("shows persisted pre-start failures even with live Bot definition=%s", async live => {
  const row = {routineId: "rt_" + "a".repeat(24), chatId: "chat_history", botId: saved.id, proposal: {name: "My task"}, status: "paused"};
  const routines = {list: vi.fn(async () => ({items: [row], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine: row, history: [{fireId: "fire_"+"a".repeat(24), scheduledFor: "2026-11-02T01:00:00Z", status: "failed", attempts: 0, failureCode: "background_not_authorized"}]})), control: vi.fn(), review: vi.fn()};
  const base = clientFixture(); base.list.mockResolvedValue({enabled: true, agents: live ? [{...saved, recipeRef: {id: "test"}} as never] : []});
  const client = {...base, bots: {routines, tasks: vi.fn(async () => []), interactions: vi.fn(async () => []), authority: vi.fn(async () => null)}} as unknown as ChatAgentClient;
  render(<BotChatPanel client={client} chatId="chat_history" directBotId={saved.id}><p>No execution messages.</p></BotChatPanel>);
  fireEvent.click(await screen.findByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "History for My task"}));
  expect(await screen.findByText(/failed · 0 attempts/)).toBeTruthy();
  expect(screen.getByText(/Execution did not complete/)).toBeTruthy();
  expect(screen.getByText("No execution messages.")).toBeTruthy();
  expect(routines.control).not.toHaveBeenCalled();
  expect(routines.review).not.toHaveBeenCalled();
});

it("filters other Chats and refuses detail identity drift", async () => {
  const row = {routineId: "rt_a", chatId: "chat_owner", proposal: {name: "Owned task"}};
  const api = {list: vi.fn(async () => ({items: [row, {...row, routineId: "rt_b", chatId: "chat_other", proposal: {name: "Other private task"}}], pending: [], nextCursor: null})),
    detail: vi.fn(async () => ({routine: {...row, chatId: "chat_other"}, history: [{status: "failed"}]}))} as unknown as BotRoutineClient;
  render(<RoutineChatHistory api={api} chatId="chat_owner"/>);
  fireEvent.click(screen.getByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "History for Owned task"}));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("Other private task")).toBeNull();
  expect(screen.queryByRole("region", {name: "Saved schedule runs"})).toBeNull();
});
it("pages archived tasks without accumulating another Chat's data", async () => {
  const cursor = {before: "2026-11-01T00:00:00Z", beforeId: "rt_a"};
  const row = {routineId: "rt_a", chatId: "chat_owner", proposal: {name: "Old archived task"}};
  const list = vi.fn(async (query = {}) => ({items: "before" in query ? [row] : [], pending: [], nextCursor: "before" in query ? null : cursor}));
  const api = {list, detail: vi.fn()} as unknown as BotRoutineClient;
  render(<RoutineChatHistory api={api} chatId="chat_owner"/>);
  fireEvent.click(screen.getByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "Archived tasks"}));
  fireEvent.click(await screen.findByRole("button", {name: "Next history page"}));
  await screen.findByRole("button", {name: "History for Old archived task"});
  expect(list).toHaveBeenLastCalledWith({...cursor, archived: "true"});
});
it("drops a late history response after navigating to a different Chat", async () => {
  const row = {routineId: "rt_a", chatId: "chat_old", proposal: {name: "Old task"}};
  let finish!: (value: unknown) => void;
  const detail = vi.fn(() => new Promise(resolve => {finish = resolve;}));
  const api = {list: vi.fn(async () => ({items: [row], pending: [], nextCursor: null})), detail} as unknown as BotRoutineClient;
  const view = render(<RoutineChatHistory api={api} chatId="chat_old"/>);
  fireEvent.click(screen.getByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "History for Old task"}));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  view.rerender(<RoutineChatHistory api={api} chatId="chat_new"/>);
  await act(async () => finish({routine: row, history: []}));
  expect(screen.queryByRole("region", {name: "Saved schedule runs"})).toBeNull();
  expect(screen.queryByRole("button", {name: "History for Old task"})).toBeNull();
});

it("keeps loaded runs when the same saved task is selected twice", async () => {
  const row = {routineId: "rt_a", chatId: "chat_owner", proposal: {name: "Owned task"}};
  const api = {list: vi.fn(async () => ({items: [row], pending: [], nextCursor: null})), detail: vi.fn(async () => ({routine: row, history: []}))} as unknown as BotRoutineClient;
  render(<RoutineChatHistory api={api} chatId="chat_owner"/>);
  fireEvent.click(screen.getByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "History for Owned task"}));
  await screen.findByText("No runs yet.");
  fireEvent.click(screen.getByRole("button", {name: "History for Owned task"}));
  expect(screen.getByText("No runs yet.")).toBeTruthy();
});
