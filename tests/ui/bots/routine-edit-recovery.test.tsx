// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { BotInteraction, BotRoutineCenterItem } from "@matrix-os/contracts";
import { ScheduleEditForm } from "../../../packages/ui/src/chat-agents/bots/ScheduleEditForm.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const routine: BotRoutineCenterItem = {routineId: "rt_"+"a".repeat(24), botId: "bot_fixture", chatId: "chat_fixture", status: "paused", revision: 2,
  proposal: {name: "Ping", prompt: "Fixed text", schedule: {kind: "interval", everyMs: 60000}, selection: {instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna"}, authorizedEffects: ["read"]},
  computerId: "test", nextFireAt: null, targetAvailable: true, sourceAvailable: true, requiresReview: false, lastFire: null};
function props(expiresAt: string) {
  const interaction: BotInteraction = {interactionId: "in_abcdefgh", agentId: routine.botId, chatId: routine.chatId, taskId: "task_fixture", kind: "approval", blocking: false,
    status: "pending", expiresAt, revision: 1, payload: {kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64),
      preview: JSON.stringify({proposal: routine.proposal, source: {computerId: "test", accountId: "account_fixture", grantRevision: 1, definitionRevision: 1, routineId: routine.routineId, baseRoutineRevision: 2}})}};
  return {routine, api: {list: vi.fn(), detail: vi.fn(), control: vi.fn(), review: vi.fn(async () => ({interaction}))}, botClient: {resolve: vi.fn()} as never,
    onChanged: vi.fn(), onRefreshRequired: vi.fn()};
}
it("retains an expired review's Web/Electron draft without automatically proposing another", async () => {
  const p = props("2000-01-01T00:00:00.000Z"); render(<ScheduleEditForm {...p} />);
  fireEvent.change(screen.getByRole("textbox", {name: "Task name"}), {target: {value: "Retained draft"}});
  fireEvent.click(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.click(await screen.findByRole("button", {name: "Return to draft"}));
  expect((screen.getByRole("textbox", {name: "Task name"}) as HTMLInputElement).value).toBe("Retained draft");
  expect(p.api.review).toHaveBeenCalledTimes(1);
});
it("recovers the draft as a displayed review expires without relying on a fresh list response", async () => {
  vi.useFakeTimers();
  const p = props(new Date(Date.now()+1000).toISOString()); render(<ScheduleEditForm {...p} />);
  await act(async () => fireEvent.click(screen.getByRole("button", {name: "Review changes"})));
  expect(screen.queryByRole("button", {name: "Return to draft"})).toBeNull();
  await act(async () => vi.advanceTimersByTime(1001));
  expect(screen.getByRole("button", {name: "Return to draft"})).toBeTruthy();
  expect(p.api.review).toHaveBeenCalledTimes(1);
});

it("does not reveal a replaceable draft while an owner decision is still unconfirmed across expiry", async () => {
  vi.useFakeTimers(); const p = props(new Date(Date.now()+1000).toISOString());
  let finish!: (value: unknown) => void;
  const resolve = vi.fn(() => new Promise(done => {finish = done;}));
  render(<ScheduleEditForm {...p} botClient={{resolve} as never} />);
  await act(async () => fireEvent.click(screen.getByRole("button", {name: "Review changes"})));
  fireEvent.click(screen.getByRole("button", {name: "Approve changes"}));
  await act(async () => vi.advanceTimersByTime(1001));
  expect((screen.getByRole("button", {name: "Return to draft"}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", {name: "Return to draft"}));
  expect(screen.queryByRole("textbox", {name: "Task name"})).toBeNull();
  await act(async () => finish({interaction: {interactionId: "in_abcdefgh", status: "resolved", revision: 2}}));
  expect(p.onChanged).toHaveBeenCalledTimes(1);
});
