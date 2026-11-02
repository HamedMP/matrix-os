// @vitest-environment jsdom
import React from "react";
import {afterEach, expect, it, vi} from "vitest";
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react";
import {RoutineChatHistory} from "../../../packages/ui/src/chat-agents/bots/RoutineChatHistory.js";
import type {BotRoutineClient} from "../../../packages/ui/src/chat-agents/bots/routine-client.js";
afterEach(cleanup);
it("cancels detail loading when the person switches history filters", async () => {
  const row = {routineId: "rt_a", chatId: "chat_owner", proposal: {name: "Owned task"}};
  let finish!: (value: unknown) => void;
  const api = {list: vi.fn(async () => ({items: [row], pending: [], nextCursor: null})), detail: vi.fn(() => new Promise(resolve => {finish = resolve;}))} as unknown as BotRoutineClient;
  render(<RoutineChatHistory api={api} chatId="chat_owner"/>);
  fireEvent.click(screen.getByText("Scheduled task history"));
  fireEvent.click(await screen.findByRole("button", {name: "History for Owned task"}));
  await screen.findByText("Loading runs…");
  fireEvent.click(screen.getByRole("button", {name: "Archived tasks"}));
  await screen.findByRole("button", {name: "History for Owned task"});
  expect(screen.queryByText("Loading runs…")).toBeNull();
  expect((screen.getByRole("button", {name: "Refresh history"}) as HTMLButtonElement).disabled).toBe(false);
  await act(async () => finish({routine: row, history: []}));
  expect(screen.queryByRole("region", {name: "Saved schedule runs"})).toBeNull();
});
