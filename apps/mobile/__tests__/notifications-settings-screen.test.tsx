const mockUseGateway = jest.fn();
let mockUserId = "owner";
// Only the native sheet host is replaced; production choices, events and state stay real.
jest.mock("@expo/ui", () => ({
  BottomSheet: ({ isPresented, children }: { isPresented: boolean; children: React.ReactNode }) => isPresented ? children : null,
  RNHostView: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("@clerk/clerk-expo", () => ({ useAuth: () => ({ userId: mockUserId }) }));
jest.mock("@/app/_layout", () => ({ useGateway: () => mockUseGateway() }));
jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({ gatewayUrl: "http://localhost:4000", userId: "owner", ready: true,
    session: async () => ({ token: "token", gatewayUrl: "http://localhost:4000" }) }),
}));
jest.mock("expo-router", () => ({
  useFocusEffect: (effect: () => void | (() => void)) => require("react").useEffect(effect, [effect]),
}));
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { DEFAULT_NOTIFICATION_PREFERENCES, NotificationPreferencesSchema } from "@matrix-os/contracts/notifications";
import NotificationsScreen from "../app/settings-detail/notifications";
import { GatewayClient } from "../lib/gateway-client";
import { jsonResponse } from "./mobile-shell-test-utils";

const originalOS = Platform.OS;
const initial = NotificationPreferencesSchema.parse({
  ...DEFAULT_NOTIFICATION_PREFERENCES, revision: 4,
  events: { ...DEFAULT_NOTIFICATION_PREFERENCES.events, question: false },
  phone: { ...DEFAULT_NOTIFICATION_PREFERENCES.phone, awayAfterSeconds: 900 },
  content: { ...DEFAULT_NOTIFICATION_PREFERENCES.content, timeSensitive: true },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let stored = NotificationPreferencesSchema.parse(initial);
let fetchMock: jest.SpyInstance;
function setup() {
  mockUseGateway.mockReturnValue({ client: new GatewayClient("http://localhost:4000", "token"), gateway: { id: "a" } });
  fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, request) => {
    if (request?.method === "PUT") stored = { ...NotificationPreferencesSchema.parse(JSON.parse(request.body as string)), revision: stored.revision + 1 };
    return jsonResponse({ preferences: stored });
  });
}
async function edit() {
  fireEvent.press(await screen.findByRole("switch", { name: "Task needs approval" }));
}
beforeEach(() => { mockUserId = "owner"; jest.clearAllMocks(); stored = NotificationPreferencesSchema.parse(initial); setup(); });
afterEach(() => { cleanup(); Platform.OS = originalOS; jest.restoreAllMocks(); });

it("saves full preferences and reloads confirmed values without enabling device push", async () => {
  const view = render(<NotificationsScreen />);
  expect((await screen.findByRole("switch", { name: "Agent asks a question" })).props.accessibilityState).toMatchObject({ checked: false });
  await edit();
  fireEvent.press(screen.getByRole("button", { name: "Minimum reply duration" }));
  fireEvent.press(screen.getByRole("button", { name: "30 seconds" }));
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText("Changes saved.");
  expect(stored.events).toMatchObject({ approval: false, question: false, minReplySeconds: 30 });
  expect(stored.phone.awayAfterSeconds).toBe(900);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(Notifications.getExpoPushTokenAsync).not.toHaveBeenCalled();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  view.unmount();
  render(<NotificationsScreen />);
  expect((await screen.findByRole("switch", { name: "Task needs approval" })).props.accessibilityState).toMatchObject({ checked: false });
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/notifications/preferences"))).toBe(true);
});
it.each([404, 503])("blocks writes after load refusal %s instead of guessing defaults", async (status) => {
  fetchMock.mockResolvedValue(jsonResponse({ error: "private" }, { status }));
  render(<NotificationsScreen />);
  await screen.findByText(status === 404 ? /Update this Matrix computer/ : /Couldn’t load notification settings/);
  expect(screen.queryByRole("switch", { name: "Task needs approval" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save notification settings" })).toBeNull();
  expect(screen.getByRole("switch", { name: "Push notifications" })).toBeTruthy();
});
it("retains edits after save failure and confirms only a successful retry", async () => {
  render(<NotificationsScreen />); await edit();
  fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 503 }));
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText(/Couldn’t save/);
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: false });
  expect(screen.queryByText("Changes saved.")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText("Changes saved.");
});
it("keeps a conflicting draft and reapplies only changed fields after explicit recovery", async () => {
  render(<NotificationsScreen />); await edit();
  stored = { ...stored, revision: 5, content: { ...stored.content, sound: false } };
  fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 409 }));
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByRole("button", { name: "Keep my changes" });
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: false });
  expect(fetchMock.mock.calls.filter(([, request]) => request?.method === "PUT")).toHaveLength(1);
  fireEvent.press(screen.getByRole("button", { name: "Keep my changes" }));
  expect(screen.getByRole("switch", { name: "Sound" }).props.accessibilityState).toMatchObject({ checked: false });
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText("Changes saved.");
  expect(stored).toMatchObject({ revision: 6, content: { sound: false }, events: { approval: false } });
});
it("retains the draft when conflict reload fails, then allows explicitly using latest", async () => {
  render(<NotificationsScreen />); await edit();
  fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 409 })).mockResolvedValueOnce(jsonResponse({}, { status: 503 }));
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText(/Couldn’t reload/);
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: false });
  expect(screen.getByRole("button", { name: "Save notification settings" }).props.accessibilityState).toMatchObject({ disabled: true });
  fireEvent.press(screen.getByRole("button", { name: "Reload notification settings" }));
  fireEvent.press(await screen.findByRole("button", { name: "Use latest" }));
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: true });
});
it("ignores an old computer's late save when the selected client changes", async () => {
  const view = render(<NotificationsScreen />); await edit();
  const pending = deferred<Response>();
  fetchMock.mockReturnValueOnce(pending.promise);
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  mockUseGateway.mockReturnValue({ client: new GatewayClient("http://localhost:5000", "other"), gateway: { id: "b" } });
  view.rerender(<NotificationsScreen />);
  await screen.findByRole("switch", { name: "Task needs approval", checked: true });
  await act(async () => pending.resolve(jsonResponse({ preferences: { ...stored, events: { ...stored.events, approval: false } } })));
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: true });
  expect(screen.queryByText("Changes saved.")).toBeNull();
});
it("hides Time Sensitive on Android while preserving it on full save", async () => {
  Platform.OS = "android";
  render(<NotificationsScreen />); await edit();
  expect(screen.queryByRole("switch", { name: "Time Sensitive" })).toBeNull();
  expect(screen.queryByText("Away after")).toBeNull();
  expect(screen.queryByText("Your devices")).toBeNull();
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText("Changes saved.");
  expect(stored.content.timeSensitive).toBe(true);
});

it("saves the phone choices and iOS content switches with one explicit save", async () => {
  Platform.OS = "ios";
  render(<NotificationsScreen />);
  await screen.findByRole("switch", { name: "Time Sensitive" });
  for (const name of ["Time Sensitive", "Sound", "Show previews", "Reply finishes", "Run fails"]) {
    fireEvent.press(screen.getByRole("switch", { name }));
  }
  fireEvent.press(screen.getByRole("button", { name: "Send to phone" }));
  fireEvent.press(screen.getByRole("button", { name: "Never" }));
  fireEvent.press(screen.getByRole("button", { name: "Unread reply delay" }));
  fireEvent.press(screen.getByRole("button", { name: "2 minutes" }));
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await screen.findByText("Changes saved.");
  expect(stored).toMatchObject({
    events: { replyFinished: false, runFailed: false },
    phone: { mode: "never", replyDelaySeconds: 120 },
    content: { timeSensitive: false, sound: false, showPreview: true },
  });
});
it("blocks duplicate saves while the request is pending", async () => {
  render(<NotificationsScreen />); await edit();
  const response = deferred<Response>();
  fetchMock.mockReturnValueOnce(response.promise);
  const save = screen.getByRole("button", { name: "Save notification settings" });
  fireEvent.press(save); fireEvent.press(save);
  await waitFor(() => expect(fetchMock.mock.calls.filter(([, request]) => request?.method === "PUT")).toHaveLength(1));
  await act(async () => response.resolve(jsonResponse({ preferences: { ...stored, revision: 5 } })));
  await screen.findByText("Changes saved.");
});
it("does not display a prior client's late load", async () => {
  const response = deferred<Response>();
  fetchMock.mockReturnValueOnce(response.promise);
  const view = render(<NotificationsScreen />);
  mockUseGateway.mockReturnValue({ client: new GatewayClient("http://localhost:5000", "other"), gateway: { id: "b" } });
  view.rerender(<NotificationsScreen />);
  await screen.findByRole("switch", { name: "Task needs approval", checked: true });
  await act(async () => response.resolve(jsonResponse({ preferences: { ...stored, events: { ...stored.events, approval: false } } })));
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: true });
});
it("does not reload a prior computer after its late save reports conflict", async () => {
  const view = render(<NotificationsScreen />); await edit();
  const response = deferred<Response>();
  fetchMock.mockReturnValueOnce(response.promise);
  fireEvent.press(screen.getByRole("button", { name: "Save notification settings" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  mockUseGateway.mockReturnValue({ client: new GatewayClient("http://localhost:5000", "other"), gateway: { id: "b" } });
  view.rerender(<NotificationsScreen />);
  await screen.findByRole("switch", { name: "Task needs approval", checked: true });
  await act(async () => response.resolve(jsonResponse({}, { status: 409 })));
  expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith("http://localhost:4000"))).toHaveLength(2);
});

it("discards late preference responses after an account change even with the same client", async () => {
  const response = deferred<Response>();
  fetchMock.mockReturnValueOnce(response.promise);
  const view = render(<NotificationsScreen />);
  mockUserId = "other-owner";
  stored = { ...stored, events: { ...stored.events, approval: false } };
  view.rerender(<NotificationsScreen />);
  await screen.findByRole("switch", { name: "Task needs approval", checked: false });
  await act(async () => response.resolve(jsonResponse({ preferences: initial })));
  expect(screen.getByRole("switch", { name: "Task needs approval" }).props.accessibilityState).toMatchObject({ checked: false });
});
