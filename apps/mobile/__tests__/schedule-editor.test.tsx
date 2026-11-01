jest.mock("../components/ui/Sheet", () => ({ Sheet: () => null }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import type { BotRoutineCenterItem, BotInteraction } from "@matrix-os/contracts";
import { ScheduleEditor } from "../components/agents/schedules/ScheduleEditor";

const routine: BotRoutineCenterItem = {routineId: "rt_" + "a".repeat(24), botId: "bot_fixture", chatId: "chat_fixture", status: "paused", revision: 2,
  proposal: { name: "Ping", prompt: "Return FIXED TEXT", schedule: {kind: "interval", everyMs: 60_000}, selection: {instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna"}, authorizedEffects: ["read"] },
  computerId: "Test Computer", nextFireAt: null, targetAvailable: true, sourceAvailable: true, requiresReview: false, lastFire: null};
const interaction: BotInteraction = {interactionId: "in_abcdefgh", chatId: routine.chatId, agentId: routine.botId, taskId: "task_fixture", kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
  payload: {kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64), preview: JSON.stringify({proposal: routine.proposal, source: {accountId: "private", computerId: "Test Computer", grantRevision: 1, definitionRevision: 1, routineId: routine.routineId, baseRoutineRevision: 2}})}};
function props() {return {routine, api: {list: jest.fn(), detail: jest.fn(), control: jest.fn(), review: jest.fn(async () => ({interaction}))},
  resolve: jest.fn(async () => ({interaction: {...interaction, status: "resolved" as const, revision: 2}})), actionsAvailable: true,
  pending: [] as BotInteraction[], pendingRead: 1, getReadSequence: () => 1, onRefresh: jest.fn(async () => undefined), onDone: jest.fn()};}
afterEach(() => { cleanup(); jest.useRealTimers(); });
it("keeps a draft across a saved revision change and explicitly reviews against the new revision", async () => {
  const p = props(); const view = render(<ScheduleEditor {...p} />);
  fireEvent.changeText(screen.getByLabelText("Task name"), "My draft");
  view.rerender(<ScheduleEditor {...p} routine={{...routine, revision: 3}} />);
  expect(screen.getByLabelText("Task name").props.value).toBe("My draft");
  fireEvent.press(screen.getByRole("button", {name: "Review against revision 3"}));
  await waitFor(() => expect(p.api.review).toHaveBeenCalledWith(routine.routineId, expect.objectContaining({baseRevision: 3, name: "My draft"})));
  expect(p.api.control).not.toHaveBeenCalled();
});
it("cancels one pending review through owner resolution while preserving the draft", async () => {
  const p = props(); render(<ScheduleEditor {...p} />);
  fireEvent.changeText(screen.getByLabelText("Task name"), "Keep this draft");
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.press(await screen.findByRole("button", {name: "Cancel"}));
  await screen.findByLabelText("Task name");
  expect(screen.getByLabelText("Task name").props.value).toBe("Keep this draft");
  expect(p.resolve).toHaveBeenCalledWith(interaction, {kind: "approval", baseRevision: 1, decision: "deny"});
  expect(p.onDone).not.toHaveBeenCalled();
});
it("recovers a review resolved elsewhere without creating or approving a replacement automatically", async () => {
  const p = props(); const view = render(<ScheduleEditor {...p} />);
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  await screen.findByRole("button", {name: "Approve changes"});
  view.rerender(<ScheduleEditor {...p} pendingRead={2} />);
  fireEvent.press(screen.getByRole("button", {name: "Return to draft"}));
  expect(screen.getByLabelText("Task name").props.value).toBe("Ping");
  expect(p.api.review).toHaveBeenCalledTimes(1);
  expect(p.resolve).not.toHaveBeenCalled();
});
it("rejects invalid timing and ignores duplicate review presses while waiting", async () => {
  const p = props(); let finish!: (value: {interaction: BotInteraction}) => void;
  p.api.review.mockImplementation(() => new Promise(done => {finish = done;}));
  render(<ScheduleEditor {...p} />);
  fireEvent.changeText(screen.getByLabelText("Interval in minutes"), "0");
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  expect(p.api.review).not.toHaveBeenCalled();
  fireEvent.changeText(screen.getByLabelText("Interval in minutes"), "2");
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  expect(p.api.review).toHaveBeenCalledTimes(1);
  await act(async () => finish({interaction}));
});

it("returns to a retained draft from an expired review without submitting a new one", async () => {
  const p = props(); p.api.review.mockResolvedValue({interaction: {...interaction, expiresAt: "2000-01-01T00:00:00.000Z"}});
  render(<ScheduleEditor {...p} />);
  fireEvent.changeText(screen.getByLabelText("Task name"), "Keep expired draft");
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.press(await screen.findByRole("button", {name: "Return to draft"}));
  expect(screen.getByLabelText("Task name").props.value).toBe("Keep expired draft");
  expect(p.api.review).toHaveBeenCalledTimes(1);
  expect(p.resolve).not.toHaveBeenCalled();
});
it("makes a draft recoverable when its visible review expires without another list read", async () => {
  jest.useFakeTimers();
  const p = props(); p.api.review.mockResolvedValue({interaction: {...interaction, expiresAt: new Date(Date.now()+1000).toISOString()}});
  render(<ScheduleEditor {...p} />);
  await act(async () => fireEvent.press(screen.getByRole("button", {name: "Review changes"})));
  expect(screen.queryByRole("button", {name: "Return to draft"})).toBeNull();
  await act(async () => jest.advanceTimersByTime(1001));
  expect(screen.getByRole("button", {name: "Return to draft"})).toBeTruthy();
  expect(p.api.review).toHaveBeenCalledTimes(1);
});

it("keeps Return to draft disabled while an already-submitted decision crosses expiry", async () => {
  jest.useFakeTimers(); const p = props();
  p.api.review.mockResolvedValue({interaction: {...interaction, expiresAt: new Date(Date.now()+1000).toISOString()}});
  let finish!: (value: Awaited<ReturnType<typeof p.resolve>>) => void;
  p.resolve.mockImplementation(() => new Promise(done => {finish = done;}));
  render(<ScheduleEditor {...p} />);
  await act(async () => fireEvent.press(screen.getByRole("button", {name: "Review changes"})));
  fireEvent.press(screen.getByRole("button", {name: "Approve changes"}));
  await act(async () => jest.advanceTimersByTime(1001));
  const back = screen.getByRole("button", {name: "Return to draft"});
  expect(back.props.accessibilityState.disabled).toBe(true);
  fireEvent.press(back);
  expect(screen.queryByLabelText("Task name")).toBeNull();
  await act(async () => finish({interaction: {...interaction, status: "resolved", revision: 2}}));
  expect(p.onDone).toHaveBeenCalledTimes(1);
});
