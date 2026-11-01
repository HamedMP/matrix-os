// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BotInteraction } from "@matrix-os/contracts";
import { InteractionCard } from "../../../packages/ui/src/chat-agents/bots/InteractionCard.js";

afterEach(cleanup);
const interaction: BotInteraction = {
  interactionId: "in_abcdefgh", chatId: "chat_fixture", agentId: "bot_fixture", taskId: "task_fixture",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 7,
  payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 3, argsDigest: "a".repeat(64),
    preview: JSON.stringify({ proposal: { name: "Morning brief", prompt: "Write a short private brief.",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Asia/Shanghai" },
      selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" }, authorizedEffects: ["read"] },
      source: { accountId: "account-private", computerId: "preview-computer", grantRevision: 3, definitionRevision: 2 } }) },
};

it("presents a schedule as an understandable approval and submits only the explicit revision-bound decision", async () => {
  const resolve = vi.fn(async () => undefined);
  render(<InteractionCard interaction={interaction} onResolve={resolve} />);
  expect(screen.getByRole("heading", { name: "Schedule Morning brief" })).toBeTruthy();
  expect(screen.getByText("Write a short private brief.")).toBeTruthy();
  expect(screen.getByText("Asia/Shanghai")).toBeTruthy();
  expect(screen.getByText(/Pause or archive/)).toBeTruthy();
  const details = screen.getByText("Technical details").closest("details")!;
  expect(details.open).toBe(false);
  expect(resolve).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Approve schedule" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith({ kind: "approval", baseRevision: 7, decision: "approve" }));
});

it("keeps expired schedule details readable without offering execution approval", () => {
  render(<InteractionCard interaction={{ ...interaction, expiresAt: "2000-01-01T00:00:00.000Z" }} onResolve={vi.fn()} />);
  expect(screen.getByText("Write a short private brief.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve schedule" })).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("expired");
});

it("submits Cancel as a denial and rejects malformed schedule details", async () => {
  const resolve = vi.fn(async () => undefined);
  render(<InteractionCard interaction={interaction} onResolve={resolve} />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith({ kind: "approval", baseRevision: 7, decision: "deny" }));
  cleanup();
  render(<InteractionCard interaction={{ ...interaction, payload: { ...interaction.payload!, kind: "approval", tool: "routine.activate", audience: "direct", argsDigest: "a".repeat(64), policyRevision: 3, preview: "{invalid" } }} onResolve={resolve} />);
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Approve schedule" })).toBeNull();
});

it("prevents duplicate approval while pending and permits a deliberate retry after a safe failure", async () => {
  let reject!: (error: Error) => void;
  const resolve = vi.fn().mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue(undefined);
  render(<InteractionCard interaction={interaction} onResolve={resolve} />);
  const approve = screen.getByRole("button", { name: "Approve schedule" }) as HTMLButtonElement;
  fireEvent.click(approve); fireEvent.click(approve);
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(approve.disabled).toBe(true);
  reject(new Error("private provider path /home/owner"));
  await screen.findByRole("alert");
  expect(screen.getByRole("alert").textContent).not.toMatch(/provider|\/home/);
  fireEvent.click(approve);
  await waitFor(() => expect(resolve).toHaveBeenCalledTimes(2));
});


it("presents an edit as changes requiring a new explicit approval, including its target revision", async () => {
  const payload = interaction.payload! as Extract<NonNullable<BotInteraction["payload"]>, {kind: "approval"}>;
  const envelope = JSON.parse(payload.preview);
  envelope.source.routineId = "rt_0123456789abcdef01234567";
  envelope.source.baseRoutineRevision = 2;
  envelope.estimatedNextFireAt = "2099-01-01T01:00:00.000Z";
  const resolve = vi.fn(async () => undefined);
  render(<InteractionCard interaction={{...interaction, payload: {...payload, preview: JSON.stringify(envelope)}}} onResolve={resolve}/>);
  expect(screen.getByRole("heading", {name: "Update schedule Morning brief"})).toBeTruthy();
  expect(screen.getByText(/Estimated next run/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", {name: "Approve changes"}));
  await waitFor(() => expect(resolve).toHaveBeenCalledExactlyOnceWith({kind: "approval", decision: "approve", baseRevision: 7}));
});

it("shows weekday-list frequency and exposes an exact fallback for an uncommon repeat rule", () => {
  const payload = interaction.payload! as Extract<NonNullable<BotInteraction["payload"]>, {kind: "approval"}>;
  const envelope = JSON.parse(payload.preview);
  envelope.proposal.schedule.expr = "0 9 * * 1,3";
  const view = render(<InteractionCard interaction={{...interaction, payload: {...payload, preview: JSON.stringify(envelope)}}} onResolve={vi.fn()}/>);
  expect(screen.getByText("Every Monday and Wednesday at 09:00")).toBeTruthy();
  envelope.proposal.schedule.expr = "*/17 9-17 * * 1-5";
  view.rerender(<InteractionCard interaction={{...interaction, payload: {...payload, preview: JSON.stringify(envelope)}}} onResolve={vi.fn()}/>);
  expect(screen.getByText("Custom repeat rule: */17 9-17 * * 1-5")).toBeTruthy();
});
