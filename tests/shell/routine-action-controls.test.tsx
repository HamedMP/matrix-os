// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { RoutineActionView } from "@matrix-os/contracts";
import { RoutineActionConfirmation } from "../../packages/ui/src/routine-action/RoutineActionConfirmation";
import type { RoutineActionClient } from "../../packages/ui/src/routine-action/client";

const challengeId = `rcact_${"a".repeat(32)}`;
const pending: RoutineActionView = {
  challengeId, actionDigest: "d".repeat(64), sourceKind: "terminal_launch", operation: "pause",
  intent: { operation: "pause", requestId: "de000000-0000-4000-8000-000000000001", routineId: `rt_${"b".repeat(24)}`, baseRevision: 3 },
  target: { botId: "bot_target", chatId: "chat_target" }, sourceLabel: "Terminal terminal_one",
  expiresAt: "2099-01-01T00:00:00.000Z", status: "pending", title: "Allow routine pause?",
  description: "Allow this operation only. Routine activation, background model consent and integration permissions remain separate.",
};
const button = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;
afterEach(cleanup);

it("gives the exact one-operation choices the established approval control styles", async () => {
  const client = { read: async () => pending, list: async () => [pending], submit: vi.fn() };
  render(<RoutineActionConfirmation client={client as RoutineActionClient} challengeId={challengeId} identity="owner-test"/>);
  await screen.findByRole("button", { name: "Allow once" });
  expect(screen.getAllByRole("button").map(value => value.textContent)).toEqual(["Allow once", "Decline", "Cancel request"]);
  for (const control of screen.getAllByRole("button")) {
    expect(control.classList.contains("matrix-chat-agent-button")).toBe(true);
    expect((control as HTMLButtonElement).disabled).toBe(false);
  }
  expect(button("Allow once").classList.contains("matrix-chat-agent-primary")).toBe(true);
  expect(button("Decline").classList.contains("matrix-chat-agent-primary")).toBe(false);
  expect(button("Cancel request").classList.contains("matrix-chat-agent-primary")).toBe(false);
  expect(client.submit).not.toHaveBeenCalled();
});

it.each(["approve", "decline", "cancel"] as const)("preserves %s callback, disables busy choices and prevents a second decision", async decision => {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  let settled = false;
  const submit = vi.fn(async () => { await waiting; settled = true; return { submission: "accepted" as const }; });
  const client = { read: async () => settled ? { ...pending, status: decision === "approve" ? "approved" as const : decision === "decline" ? "declined" as const : "cancelled" as const } : pending,
    list: async () => [pending], submit };
  render(<RoutineActionConfirmation client={client} challengeId={challengeId} identity="owner-test"/>);
  await screen.findByRole("button", { name: "Allow once" });
  const label = decision === "approve" ? "Allow once" : decision === "decline" ? "Decline" : "Cancel request";
  fireEvent.click(button(label));
  fireEvent.click(button("Allow once"));
  expect(screen.getAllByRole("button").every(value => (value as HTMLButtonElement).disabled)).toBe(true);
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledWith(challengeId, { decision, actionDigest: pending.actionDigest, clientRequestId: expect.any(String) }, expect.any(AbortSignal));
  await act(async () => { release(); await waiting; });
  await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
});

it.each(["expired", "approved", "declined", "cancelled", "unavailable"] as const)("never offers an action for %s", async status => {
  const client = { read: async () => ({ ...pending, status }), list: async () => [], submit: vi.fn() };
  render(<RoutineActionConfirmation client={client as RoutineActionClient} challengeId={challengeId} identity="owner-test"/>);
  await screen.findByText(pending.title);
  expect(screen.queryByRole("button")).toBeNull();
  expect(client.submit).not.toHaveBeenCalled();
});

it("hides decisions when a server-pending request is already past its deadline", async () => {
  const client = { read: async () => ({ ...pending, expiresAt: "2000-01-01T00:00:00.000Z" }), list: async () => [], submit: vi.fn() };
  render(<RoutineActionConfirmation client={client as RoutineActionClient} challengeId={challengeId} identity="owner-test"/>);
  await screen.findByText("This request expired");
  expect(screen.queryByRole("button")).toBeNull();
  expect(client.submit).not.toHaveBeenCalled();
});

it("styles the native browser handoff and keeps it separate from a decision", async () => {
  const open = vi.fn(async () => {}), submit = vi.fn();
  const client = { read: async () => pending, list: async () => [], submit };
  render(<RoutineActionConfirmation client={client as RoutineActionClient} challengeId={challengeId} identity="native-test" openConfirmation={open}/>);
  const control = await screen.findByRole("button", { name: "Confirm in browser" });
  expect(control.classList.contains("matrix-chat-agent-primary")).toBe(true);
  expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
  fireEvent.click(control);
  await screen.findByRole("button", { name: "Reopen owner confirmation" });
  expect(open).toHaveBeenCalledWith(challengeId, expect.any(AbortSignal));
  expect(submit).not.toHaveBeenCalled();
});
