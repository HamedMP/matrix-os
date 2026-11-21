// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BotInteraction, RoutineChatOriginView } from "@matrix-os/contracts";
import { ChatApp } from "../../shell/src/components/ChatApp";
import type { ChatMessage } from "../../shell/src/lib/chat";

const origin = vi.hoisted(() => ({ use: vi.fn(), resolve: vi.fn(), refresh: vi.fn() }));
vi.mock("@clerk/nextjs", () => ({ useOrganization: () => ({ organization: null }), useAuth: () => ({ userId: null, sessionId: null }) }));
vi.mock("../../shell/src/components/chat-provider-onboarding", () => ({ ChatProviderOnboarding: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("@matrix-os/ui", async original => ({ ...await original<typeof import("@matrix-os/ui")>(), useRoutineOrigin: origin.use }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const interaction: BotInteraction = {
  interactionId: "in_walkthrough", chatId: "chat_executor", agentId: "bot_fixture", taskId: "task_fixture",
  kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: { kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64),
    preview: JSON.stringify({ proposal: { name: "Morning brief", prompt: "Reply here.", schedule: { kind: "interval", everyMs: 120000 },
      selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" }, authorizedEffects: ["send"] },
    source: { accountId: "account_fixture", computerId: "computer_fixture", grantRevision: 1, definitionRevision: 1 } }) },
};
const anchored = { sourceChatId: "chat_source", anchorMessageId: "msg_request", interaction };
const result: ChatMessage = { id: "msg_result", role: "system", content: "Scheduled reply", timestamp: 3,
  routineReceipt: { type: "routine_receipt", engine: "matrix", kind: "output", routineId: `rt_${"a".repeat(24)}`,
    fireId: `fire_${"b".repeat(24)}`, attempt: 1, status: "completed", scheduledFor: "2026-11-07T00:00:00.000Z",
    canonicalChatId: "chat_executor", canonicalTaskId: "task_fixture", model: "gpt-6-luna" } };
const messages: ChatMessage[] = [
  { id: "msg_request", role: "user", content: "Schedule a reply", timestamp: 1 },
  { id: "msg_proposal", role: "assistant", content: "The task is ready for review", timestamp: 2 },
  result,
  { id: "msg_later", role: "user", content: "A later conversation", timestamp: 4 },
  { ...result, id: "msg_second_result", content: "A second scheduled reply", timestamp: 5,
    routineReceipt: { ...result.routineReceipt!, fireId: `fire_${"c".repeat(24)}` } },
];
const setView = (view: RoutineChatOriginView & { history?: Array<typeof anchored & { decision: "approve" }> }) => origin.use.mockReturnValue({
  view, pending: false, fresh: true, notice: "", error: "", uncertain: null, resolve: origin.resolve, refresh: origin.refresh,
});
const base = { sourceChatId: "chat_source", deliveries: [], deliveryPending: false, hasMore: false };
const host = () => <ChatApp messages={messages} busy={false} connected sessionId="chat_source" conversations={[]}
  onSubmit={vi.fn()} onNewChat={vi.fn()} onSwitchConversation={vi.fn()} />;
const before = (left: HTMLElement, right: HTMLElement) => Boolean(left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING);

it("keeps pending and approved schedule cards at the proposal, before the result and later conversation", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  setView({ ...base, pending: [anchored] });
  const { rerender } = render(host());
  const card = () => screen.getByRole("region", { name: "Schedule Morning brief" });
  const verifyOrder = () => {
    expect(before(screen.getByText("The task is ready for review"), card())).toBe(true);
    expect(before(card(), screen.getByText("Scheduled reply"))).toBe(true);
    expect(before(screen.getByText("Scheduled reply"), screen.getByText("A later conversation"))).toBe(true);
    expect(before(screen.getByText("A later conversation"), screen.getByText("A second scheduled reply"))).toBe(true);
  };
  verifyOrder();
  expect(within(card()).getByRole("button", { name: "Approve schedule" })).toBeTruthy();

  setView({ ...base, pending: [], history: [{ ...anchored, interaction: { ...interaction, status: "resolved", revision: 2 }, decision: "approve" }] });
  rerender(host());
  verifyOrder();
  expect(within(card()).getByText("Approved", { exact: true })).toBeTruthy();
  expect(within(card()).queryByRole("button", { name: "Approve schedule" })).toBeNull();
  expect(within(card()).queryByText("First run", { exact: true })).toBeNull();
});

it("labels an off-page pending approval as earlier without appending off-page history", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const pending = { ...anchored, anchorMessageId: "msg_earlier" };
  setView({ ...base, pending: [pending], history: [{ ...pending,
    interaction: { ...interaction, interactionId: "in_old", status: "resolved", revision: 2 }, decision: "approve" }] });
  render(host());
  const earlier = screen.getByRole("region", { name: "Scheduled task approvals from earlier messages" });
  expect(before(earlier, screen.getByText("Schedule a reply"))).toBe(true);
  expect(within(earlier).getByRole("button", { name: "Approve schedule" })).toBeTruthy();
  expect(screen.queryByText("Approved", { exact: true })).toBeNull();
});

it("keeps a Schedules edit review separate from the original creation turn", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  const payload = interaction.payload;
  if (payload?.kind !== "approval") throw new Error("Expected routine approval fixture");
  const preview = JSON.parse(payload.preview);
  setView({ ...base, pending: [{ ...anchored, interaction: { ...interaction, payload: {
    ...payload, preview: JSON.stringify({ ...preview, source: { ...preview.source, routineId: `rt_${"a".repeat(24)}`, baseRoutineRevision: 1 } }),
  } } }] });
  render(host());
  const card = screen.getByRole("region", { name: "Update schedule Morning brief" });
  expect(before(screen.getByText("A second scheduled reply"), card)).toBe(true);
  expect(within(card).getByRole("button", { name: "Approve changes" })).toBeTruthy();
});
