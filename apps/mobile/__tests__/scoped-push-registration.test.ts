import * as SecureStore from "expo-secure-store";
import * as Notifications from "expo-notifications";
import { disablePushNotifications, isPushNotificationsEnabled } from "../lib/push";
import { syncPushRegistration } from "../lib/push-registration-sync";
import { jsonResponse } from "./mobile-shell-test-utils";

const token = "ExponentPushToken[phone]";
const primary = { clerkToken: "owner-token", gatewayUrl: "https://app.matrix-os.com/vm/primary" };
const preview = { clerkToken: "owner-token", gatewayUrl: "https://app.matrix-os.com/vm/preview?runtime=review" };

beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.restoreAllMocks());

it("turns off only this computer, retains the phone token for the other computer, and does not re-enable on foreground", async () => {
  let cached: string | null = token;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async () => cached);
  jest.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => { cached = null; });
  const registered = new Set(["/vm/primary", "/vm/preview"]);
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (rawUrl, request) => {
    const url = new URL(String(rawUrl));
    const computer = url.pathname.split("/api/")[0];
    expect(JSON.parse(request?.body as string)).toMatchObject({ token });
    if (url.pathname.endsWith("/status")) return jsonResponse({ registered: registered.has(computer) });
    if (request?.method === "DELETE") registered.delete(computer);
    else registered.add(computer);
    return jsonResponse({ ok: true });
  });

  await disablePushNotifications(primary);

  expect(await isPushNotificationsEnabled(primary)).toBe(false);
  expect(await isPushNotificationsEnabled(preview)).toBe(true);
  expect(cached).toBe(token);
  expect(await syncPushRegistration(primary)).toBe("off");
  expect(registered).toEqual(new Set(["/vm/preview"]));
  expect(fetchMock.mock.calls.some(([url, request]) => String(url).includes("/register") && request?.method === "POST")).toBe(false);
});

it("reads self-hosted registration using the same Basic credential as preferences", async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(token);
  const fetchMock = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ registered: true }));
  expect(await isPushNotificationsEnabled({ clerkToken: "Basic dGVzdDp0ZXN0", gatewayUrl: "http://127.0.0.1:4951" })).toBe(true);
  expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:4951/api/push/status", expect.objectContaining({
    method: "POST", headers: expect.objectContaining({ Authorization: "Basic dGVzdDp0ZXN0" }),
  }));
});

it("recovers a legacy phone identity whose cache was deleted while another computer stayed registered, without enrolling or prompting", async () => {
  let cached: string | null = null;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async () => cached);
  jest.mocked(SecureStore.setItemAsync).mockImplementation(async (_key, value) => { cached = value; });
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: true } as Notifications.NotificationPermissionsStatus);
  jest.mocked(Notifications.getExpoPushTokenAsync).mockResolvedValue({ data: token, type: "expo" });
  const fetchMock = jest.spyOn(global, "fetch").mockImplementation(async (url, request) => {
    expect(new URL(String(url)).pathname.endsWith("/api/push/status")).toBe(true);
    expect(JSON.parse(request?.body as string)).toEqual({ token });
    return jsonResponse({ registered: String(url).includes("/vm/preview/") });
  });
  const permissionsBefore = jest.mocked(Notifications.requestPermissionsAsync).mock.calls.length;

  expect(await isPushNotificationsEnabled(preview)).toBe(true);
  expect(await syncPushRegistration(primary)).toBe("off");

  expect(cached).toBe(token);
  expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(permissionsBefore);
  expect(fetchMock.mock.calls.every(([url]) => String(url).includes("/api/push/status"))).toBe(true);
});

it("keeps missing identity unknown when permission is unavailable rather than claiming the computer is off", async () => {
  jest.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue({ granted: false } as Notifications.NotificationPermissionsStatus);
  const fetchMock = jest.spyOn(global, "fetch");
  await expect(isPushNotificationsEnabled(preview)).rejects.toThrow(/unavailable/i);
  expect(fetchMock).not.toHaveBeenCalled();
});
