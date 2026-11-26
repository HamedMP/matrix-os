import * as Notifications from "expo-notifications";
import { AndroidImportance } from "expo-notifications";
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";

import { createNotificationChannelsAtStartup, ensureNotificationChannels } from "@/lib/notification-channels";
import { enablePushNotifications } from "@/lib/push";
import { syncPushRegistration } from "@/lib/push-registration-sync";

jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  AndroidImportance: { DEFAULT: 3, HIGH: 4, MAX: 5 },
}));

jest.mock("@/lib/requests/settings", () => ({
  updatePushRegistration: jest.fn(() => Promise.resolve()),
  refreshPushRegistration: jest.fn(() => Promise.resolve(true)),
  fetchPushRegistrationStatus: jest.fn(() => Promise.resolve(true)),
}));

const notifications = jest.mocked(Notifications);
const originalPlatform = Platform.OS;

/** Every native call, in the order it settles. */
let events: string[];

function createdChannels(): Record<string, unknown> {
  return Object.fromEntries(
    notifications.setNotificationChannelAsync.mock.calls.map(([id, options]) => [id, options]),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  events = [];
  // A channel settles a tick after it is requested, so a caller that does not
  // wait for it asks for the permission or the token first.
  notifications.setNotificationChannelAsync.mockImplementation(async (id) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    events.push(`channel:${id}`);
    return null;
  });
  notifications.getPermissionsAsync.mockImplementation(async () => {
    events.push("permission");
    return { granted: false } as Notifications.NotificationPermissionsStatus;
  });
  notifications.requestPermissionsAsync.mockImplementation(async () => {
    events.push("permission-request");
    return { granted: true } as Notifications.NotificationPermissionsStatus;
  });
  notifications.getExpoPushTokenAsync.mockImplementation(async () => {
    events.push("token");
    return { data: "ExponentPushToken[test]", type: "expo" };
  });
});

afterEach(() => {
  Platform.OS = originalPlatform;
  jest.restoreAllMocks();
});

describe("Android notification channels", () => {
  beforeEach(() => {
    Platform.OS = "android";
  });

  it("creates the replies and attention channels that later pushes name", async () => {
    await ensureNotificationChannels();

    expect(createdChannels()).toEqual(expect.objectContaining({
      replies: expect.objectContaining({ name: "Replies", importance: AndroidImportance.DEFAULT }),
      attention: expect.objectContaining({
        name: "Approvals and questions",
        importance: AndroidImportance.HIGH,
      }),
    }));
  });

  it("keeps the default channel today's pushes land on, unchanged", async () => {
    await ensureNotificationChannels();

    expect(createdChannels().default).toEqual({
      name: "Matrix OS",
      importance: AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#2B3715",
    });
  });

  it("creates every channel before asking for permission or a push token", async () => {
    await enablePushNotifications({ clerkToken: "clerk", gatewayUrl: "https://app.matrix-os.com" });

    expect(events).toEqual([
      expect.stringMatching(/^channel:/),
      expect.stringMatching(/^channel:/),
      expect.stringMatching(/^channel:/),
      "permission",
      "permission-request",
      "token",
    ]);
    expect(events.slice(0, 3).sort()).toEqual(["channel:attention", "channel:default", "channel:replies"]);
  });

  it("also waits for channels before the launch re-registration permission prompt", async () => {
    jest.mocked(SecureStore.getItemAsync).mockResolvedValue("ExponentPushToken[previous-install]");
    notifications.getPermissionsAsync.mockImplementation(async () => {
      events.push("permission");
      return { granted: false, canAskAgain: true } as Notifications.NotificationPermissionsStatus;
    });

    await syncPushRegistration({ clerkToken: "clerk", gatewayUrl: "https://app.matrix-os.com" });

    expect(events.slice(0, 3).sort()).toEqual(["channel:attention", "channel:default", "channel:replies"]);
    expect(events.indexOf("permission-request")).toBeGreaterThan(2);
    expect(events.indexOf("token")).toBeGreaterThan(events.indexOf("permission-request"));
  });

  it("logs a channel that cannot be created at startup instead of failing the launch", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    notifications.setNotificationChannelAsync.mockRejectedValueOnce(new Error("channel service down"));

    expect(() => createNotificationChannelsAtStartup()).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(warn).toHaveBeenCalledWith("[mobile] Notification channels could not be created:", "channel service down");
  });
});

describe("iOS", () => {
  beforeEach(() => {
    Platform.OS = "ios";
  });

  it("has no channels to create", async () => {
    await ensureNotificationChannels();
    createNotificationChannelsAtStartup();

    expect(notifications.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});
