import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { PushRegistrationSync } from "../components/PushRegistrationSync";
import { DevicePushSettings } from "../components/settings/DevicePushSettings";
import type { NotificationComputer } from "../lib/use-notification-computer";
import { jsonResponse } from "./mobile-shell-test-utils";

const mockPush = jest.fn();
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock("@/lib/use-notification-computer", () => ({ useNotificationComputer: () => mockComputer }));

const TOKEN = "ExponentPushToken[retained-before-upgrade]";
const GATEWAY_URL = "https://app.matrix-os.com/vm/preview?runtime=review";
const computerA = {
  client: {}, url: GATEWAY_URL, key: `owner:${GATEWAY_URL}`, name: "Preview computer", address: "https://app.matrix-os.com/vm/preview",
  session: async () => ({ clerkToken: "owner-token", gatewayUrl: GATEWAY_URL, scopeKey: `owner:${GATEWAY_URL}` }),
} as NotificationComputer;
let mockComputer = computerA;
let enabled: boolean | null;
let listener: ((state: AppStateStatus) => void) | undefined;
let fetchMock: jest.SpyInstance;
let alert: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  enabled = null;
  mockComputer = computerA;
  AppState.currentState = "active";
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, callback) => {
    listener = callback; return { remove: jest.fn() };
  });
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => undefined);
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(TOKEN);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as Notifications.NotificationPermissionsStatus);
  jest.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ data: TOKEN, type: "expo" });
  fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (_url, request) => {
    if (String(_url).includes("/api/push/status")) return jsonResponse({ enabled, registered: enabled === true });
    const input = JSON.parse(request?.body as string);
    if (request?.method === "DELETE") enabled = false;
    else if (input.mode === "enable") enabled = true;
    return jsonResponse(input.mode === "refresh" ? { ok: true, registered: enabled === true } : { ok: true });
  });
});
afterEach(() => { cleanup(); jest.restoreAllMocks(); });

function reviewAction() {
  return alert.mock.calls[0]?.[2]?.find((button: { text: string }) => button.text === "Review settings");
}

it("offers a named foreground recovery path, then explicitly restores only the selected computer", async () => {
  render(<PushRegistrationSync />);
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  expect(alert.mock.calls[0][1]).toContain("Preview computer");
  expect(alert.mock.calls[0][1]).toContain(computerA.address);
  expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/push/status"))).toBe(true);
  await act(async () => reviewAction().onPress());
  expect(mockPush).toHaveBeenCalledWith("/settings-detail/notifications");

  render(<DevicePushSettings computer={computerA} />);
  await screen.findByText("Your notification choice for this computer needs confirmation.");
  expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState.disabled).toBe(true);
  fireEvent.press(screen.getByRole("button", { name: "Enable for this computer" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState).toMatchObject({ checked: true, disabled: false }));
  const writes = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/push/register"));
  expect(writes).toHaveLength(1);
  expect(writes[0][0]).toBe("https://app.matrix-os.com/vm/preview/api/push/register?runtime=review");
  expect(JSON.parse(writes[0][1]?.body as string)).toEqual({ token: TOKEN, platform: "ios", identity: TOKEN, mode: "enable" });
});

it("records Keep off as an explicit per-computer choice and does not ask or register on foreground again", async () => {
  render(<PushRegistrationSync />);
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  render(<DevicePushSettings computer={computerA} />);
  fireEvent.press(await screen.findByRole("button", { name: "Keep off for this computer" }));
  await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState).toMatchObject({ checked: false, disabled: false }));
  await act(async () => listener?.("active"));
  expect(alert).toHaveBeenCalledTimes(1);
  const writes = fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/push/register"));
  expect(writes).toHaveLength(1);
  expect(writes[0][1]?.method).toBe("DELETE");
  expect(JSON.parse(writes[0][1]?.body as string)).toEqual({ token: TOKEN });
});

it.each([["Enable for this computer", true], ["Keep off for this computer", false]] as const)(
  "retains an unknown choice after %s fails and confirms only its explicit retry", async (label, selected) => {
    const normal = fetchMock.getMockImplementation()!;
    let fail = true;
    fetchMock.mockImplementation(async (url, request) => {
      if (String(url).includes("/api/push/register") && fail) {
        fail = false;
        return jsonResponse({}, { status: 503 });
      }
      return normal(url, request);
    });
    render(<DevicePushSettings computer={computerA} />);
    fireEvent.press(await screen.findByRole("button", { name: label }));
    await screen.findByText("Couldn’t save this computer’s notification choice. Try again.");
    expect(enabled).toBeNull();
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState.disabled).toBe(true);
    expect(screen.getByRole("button", { name: label }).props.accessibilityState.disabled).toBe(false);
    fireEvent.press(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: selected, disabled: false }));
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/push/register"))).toHaveLength(2);
  },
);

it("leaves known explicit off silent and off, even with a retained global token", async () => {
  enabled = false;
  render(<PushRegistrationSync />);
  await act(async () => {});
  expect(alert).not.toHaveBeenCalled();
  expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/push/status"))).toBe(true);
});

it("does not turn unavailable status into a recovery offer or a grant", async () => {
  fetchMock.mockResolvedValue(jsonResponse({}, { status: 503 }));
  render(<PushRegistrationSync />);
  await act(async () => {});
  expect(alert).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/push/status"))).toBe(true);
});

it("offers recovery only once for repeated foregrounds of the same computer", async () => {
  render(<PushRegistrationSync />);
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  await act(async () => listener?.("active"));
  await act(async () => listener?.("active"));
  expect(alert).toHaveBeenCalledTimes(1);
});

it("ignores an old recovery action after the selected computer changes", async () => {
  const view = render(<PushRegistrationSync />);
  await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
  const review = reviewAction();
  enabled = false;
  mockComputer = { ...computerA, key: "owner:other", url: "https://app.matrix-os.com/vm/other",
    session: async () => ({ clerkToken: "owner-token", gatewayUrl: "https://app.matrix-os.com/vm/other", scopeKey: "owner:other" }) };
  view.rerender(<PushRegistrationSync />);
  await act(async () => review.onPress());
  expect(mockPush).not.toHaveBeenCalled();
});

it("does not offer an old computer's unknown result when its status completes after a switch", async () => {
  let finish!: (response: Response) => void;
  fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
  const view = render(<PushRegistrationSync />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  enabled = false;
  mockComputer = { ...computerA, key: "owner:other", url: "https://app.matrix-os.com/vm/other",
    session: async () => ({ clerkToken: "owner-token", gatewayUrl: "https://app.matrix-os.com/vm/other", scopeKey: "owner:other" }) };
  view.rerender(<PushRegistrationSync />);
  await act(async () => finish(jsonResponse({ enabled: null, registered: false })));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(alert).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/push/status"))).toBe(true);
});
