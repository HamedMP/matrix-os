jest.mock("@clerk/clerk-expo", () => ({useAuth: jest.fn()}));
jest.mock("../components/ui/Sheet", () => ({Sheet: () => null}));
import {act, cleanup, fireEvent, render, screen} from "@testing-library/react-native";
import type {BotRoutineClient} from "@matrix-os/ui/bot-routine-client";
import {RoutineChatHistory} from "../components/agents/schedules/RoutineChatHistory";
afterEach(cleanup);
it("shows a saved pre-start failure in its Chat without a model message or any mutation", async () => {
  const row = {routineId: "rt_"+"a".repeat(24), chatId: "chat_saved", proposal: {name: "My task"}};
  const api = {list: jest.fn(async () => ({items: [row], nextCursor: null, pending: []})), detail: jest.fn(async () => ({routine: row, history: [{fireId: "fire_saved", scheduledFor: "2026-11-02T01:00:00Z", status: "failed", attempts: 0, failureCode: "background_not_authorized"}]})), control: jest.fn(), review: jest.fn()};
  render(<RoutineChatHistory api={api as unknown as BotRoutineClient} chatId="chat_saved"/>);
  expect(api.list).not.toHaveBeenCalled();
  fireEvent.press(screen.getByRole("button", {name: "Scheduled task history"}));
  fireEvent.press(await screen.findByRole("button", {name: "History for My task"}));
  expect(await screen.findByText(/failed · 0 attempts/)).toBeTruthy();
  expect(screen.getByText(/Execution did not complete/)).toBeTruthy();
  expect(api.control).not.toHaveBeenCalled();
  expect(api.review).not.toHaveBeenCalled();
});

it("clears pending detail loading when switching to archived tasks", async () => {
  const row = {routineId: "rt_a", chatId: "chat_saved", proposal: {name: "My task"}};
  let finish!: (value: unknown) => void;
  const api = {list: jest.fn(async () => ({items: [row], pending: [], nextCursor: null})), detail: jest.fn(() => new Promise(resolve => {finish = resolve;}))};
  render(<RoutineChatHistory api={api as unknown as BotRoutineClient} chatId="chat_saved"/>);
  fireEvent.press(screen.getByRole("button", {name: "Scheduled task history"}));
  fireEvent.press(await screen.findByRole("button", {name: "History for My task"}));
  await screen.findByText("Loading runs…");
  fireEvent.press(screen.getByRole("button", {name: "Archived tasks"}));
  await screen.findByRole("button", {name: "History for My task"});
  expect(screen.queryByText("Loading runs…")).toBeNull();
  expect(screen.getByRole("button", {name: "Refresh history"}).props.accessibilityState.disabled).toBe(false);
  await act(async () => finish({routine: row, history: []}));
});
