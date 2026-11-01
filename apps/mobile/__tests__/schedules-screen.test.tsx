jest.mock("../components/ui/Sheet", () => ({ Sheet: () => null }));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import type { BotRoutineClient } from "@matrix-os/ui/bot-routine-client";
import { SchedulesScreen } from "../components/agents/schedules/SchedulesScreen";

afterEach(() => { cleanup(); jest.restoreAllMocks(); });
const routine = { routineId: "rt_" + "a".repeat(24), botId: "bot_fixture", chatId: "chat_fixture",
  proposal: { name: "Private ping", prompt: "Return FIXED TEXT", schedule: { kind: "interval", everyMs: 60_000 },
    selection: { instanceId: "matrix_chatgpt_plan", model: "gpt-6-luna" }, authorizedEffects: ["read"] },
  computerId: "Test Computer", status: "active", revision: 2, nextFireAt: "2099-01-01T00:00:00.000Z",
  requiresReview: false, targetAvailable: true, sourceAvailable: true, lastFire: null } as const;
function api() {
  return { list: jest.fn(async () => ({items: [routine], pending: [], nextCursor: null})),
    detail: jest.fn(async () => ({routine, history: []})),
    control: jest.fn(async (_id, input) => ({routineId: routine.routineId, status: input.status, revision: 3})),
    review: jest.fn() } as unknown as BotRoutineClient & { list: jest.Mock; detail: jest.Mock; control: jest.Mock; review: jest.Mock };
}
function draw(client = api()) {
  render(<SchedulesScreen api={client} resolve={jest.fn()} onBack={jest.fn()} />);
  return client;
}
it("shows bounded owner DTOs, timing, Computer and revision-bound pause without model text", async () => {
  const client = draw();
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Pause"}));
  await waitFor(() => expect(client.control).toHaveBeenCalledWith(routine.routineId, {baseRevision: 2, status: "paused"}));
});
it("does not remove a task until the owner confirms archive and the server accepts", async () => {
  const client = draw();
  const alert = jest.spyOn(Alert, "alert");
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Archive"}));
  expect(client.control).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith("Archive Private ping?", expect.any(String), expect.any(Array));
  await act(async () => alert.mock.calls[0][2]!.find(value => value.text === "Archive")!.onPress!());
  expect(client.control).toHaveBeenCalledWith(routine.routineId, {baseRevision: 2, status: "archived"});
});
it("does not reopen old details after the person returns to the list", async () => {
  const client = api(); let finish!: (value: unknown) => void;
  client.detail.mockImplementation(() => new Promise(resolve => {finish = resolve;}));
  draw(client);
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  fireEvent.press(screen.getByRole("button", {name: "Back to list"}));
  await act(async () => finish({routine, history: []}));
  expect(screen.queryByText("Return FIXED TEXT")).toBeNull();
});
it("keeps an edit draft across a failed review and never directly applies it", async () => {
  const client = draw(); client.review.mockRejectedValue(new Error("private server detail"));
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Edit"}));
  fireEvent.changeText(screen.getByLabelText("Task name"), "Changed task");
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  await screen.findByText(/Your draft is kept/);
  expect(screen.getByLabelText("Task name").props.value).toBe("Changed task");
  expect(client.review).toHaveBeenCalledWith(routine.routineId, expect.objectContaining({baseRevision: 2, name: "Changed task"}));
  expect(client.control).not.toHaveBeenCalled();
  expect(screen.queryByText("private server detail")).toBeNull();
});

it("retains an accepted pause even when the next detail read is older", async () => {
  const client = draw();
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Pause"}));
  await screen.findByRole("button", {name: "Resume"});
  expect(screen.getByText("Paused · Revision 3")).toBeTruthy();
  fireEvent.press(screen.getByRole("button", {name: "Back to list"}));
  expect(screen.getByText(/Paused · Every 1 minute/)).toBeTruthy();
});
it("keeps actions fenced if detail refresh fails even when the list succeeds later", async () => {
  const client = draw();
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  let list!: (value: unknown) => void;
  client.list.mockImplementationOnce(() => new Promise(resolve => { list = resolve; }));
  client.detail.mockRejectedValueOnce(new Error("private detail"));
  fireEvent.press(screen.getByRole("button", {name: "Refresh"}));
  await act(async () => Promise.resolve());
  await act(async () => list({items: [routine], pending: [], nextCursor: null}));
  await screen.findByText("Status unavailable. Refresh before responding.");
  expect(screen.getByRole("button", {name: "Pause"}).props.accessibilityState.disabled).toBe(true);
});

it("an approval completed after a filter switch refreshes only the current filter", async () => {
  const client = api();
  const proposal = {interactionId: "in_abcdefgh", chatId: "chat_fixture", agentId: "bot_fixture", taskId: "task_fixture", kind: "approval", blocking: true, status: "pending", expiresAt: "2099-01-01T00:00:00.000Z", revision: 1,
    payload: {kind: "approval", tool: "routine.activate", audience: "direct", policyRevision: 1, argsDigest: "a".repeat(64), preview: JSON.stringify({proposal: routine.proposal, source: {accountId: "private", computerId: "Test Computer", grantRevision: 1, definitionRevision: 1, routineId: routine.routineId, baseRoutineRevision: 2}})}};
  client.review.mockResolvedValue({interaction: proposal});
  client.list.mockImplementation(async (query) => ({items: query?.archived === "true" ? [] : [routine], pending: [], nextCursor: null}));
  let finish!: (value: unknown) => void;
  const resolve = jest.fn(() => new Promise(done => {finish = done;}));
  render(<SchedulesScreen api={client} resolve={resolve as never} onBack={jest.fn()} />);
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Edit"}));
  fireEvent.press(screen.getByRole("button", {name: "Review changes"}));
  fireEvent.press(await screen.findByRole("button", {name: "Approve changes"}));
  fireEvent.press(screen.getByRole("button", {name: "Show archived"}));
  await screen.findByText("No archived schedules.");
  await act(async () => finish({interaction: {...proposal, status: "resolved", revision: 2}}));
  expect(client.list.mock.calls.at(-1)[0].archived).toBe("true");
  expect(screen.queryByRole("button", {name: "Private ping"})).toBeNull();
});

it("does not submit an archive confirmation after its owner/Computer screen unmounts", async () => {
  const client = api(), alert = jest.spyOn(Alert, "alert");
  const view = render(<SchedulesScreen api={client} resolve={jest.fn()} onBack={jest.fn()} />);
  fireEvent.press(await screen.findByRole("button", {name: "Private ping"}));
  await screen.findByText("Return FIXED TEXT");
  fireEvent.press(screen.getByRole("button", {name: "Archive"}));
  const confirm = alert.mock.calls[0][2]!.find(value => value.text === "Archive")!.onPress!;
  view.unmount();
  await act(async () => confirm());
  expect(client.control).not.toHaveBeenCalled();
});

it("shows a completed one-time schedule as having no next run, without calling it paused or archived", async () => {
  const client = api(); client.list.mockResolvedValue({items: [{...routine, nextFireAt: null, proposal: {...routine.proposal, schedule: {kind: "once", at: "2026-10-31T00:00:00.000Z"}}}], pending: [], nextCursor: null});
  draw(client);
  expect(await screen.findByText("Next run: None scheduled")).toBeTruthy();
  expect(screen.queryByText(/No future run while paused or archived/)).toBeNull();
});
