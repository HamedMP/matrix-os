import { act, render } from "@testing-library/react-native";
import { AppState, type AppStateStatus } from "react-native";
import * as Notifications from "expo-notifications";

import { PushRegistrationSync } from "../components/PushRegistrationSync";
import { queuePushChange, syncPushRegistration } from "../lib/push-registration-sync";

const mockIsPushOn = jest.fn<Promise<boolean>, []>();
const mockEnablePush = jest.fn<Promise<void>, [unknown]>();
const mockDisablePush = jest.fn<Promise<void>, [unknown]>();

jest.mock("@/lib/push", () => ({
  isPushNotificationsEnabled: () => mockIsPushOn(),
  enablePushNotifications: (input: unknown) => mockEnablePush(input),
  disablePushNotifications: (input: unknown) => mockDisablePush(input),
}));

const mockGateway = {
  gatewayUrl: null as string | null,
  session: jest.fn(async (): Promise<{ token: string; gatewayUrl: string } | null> => (
    mockGateway.gatewayUrl ? { token: "clerk-token", gatewayUrl: mockGateway.gatewayUrl } : null
  )),
};

jest.mock("@/lib/queries/use-active-gateway", () => ({
  useActiveGateway: () => ({ gatewayUrl: mockGateway.gatewayUrl, session: mockGateway.session }),
}));

const SESSION = { clerkToken: "clerk-token", gatewayUrl: "https://app.example.test/vm/amin" };

const granted = { granted: true, status: "granted", canAskAgain: true } as Notifications.NotificationPermissionsStatus;
const notAsked = { granted: false, status: "undetermined", canAskAgain: true } as Notifications.NotificationPermissionsStatus;
const refused = { granted: false, status: "denied", canAskAgain: false } as Notifications.NotificationPermissionsStatus;

beforeEach(() => {
  jest.clearAllMocks();
  mockIsPushOn.mockResolvedValue(true);
  mockEnablePush.mockResolvedValue();
  mockDisablePush.mockResolvedValue();
  jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue(granted);
  jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue(granted);
  mockGateway.gatewayUrl = SESSION.gatewayUrl;
});

describe("syncPushRegistration", () => {
  it("leaves a phone with push off alone: no permission prompt and no registration", async () => {
    mockIsPushOn.mockResolvedValue(false);

    await expect(syncPushRegistration(SESSION)).resolves.toBe("off");

    expect(Notifications.getPermissionsAsync).not.toHaveBeenCalled();
    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockEnablePush).not.toHaveBeenCalled();
  });

  it("registers this phone with the computer again while push is on and allowed", async () => {
    await expect(syncPushRegistration(SESSION)).resolves.toBe("registered");

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockEnablePush).toHaveBeenCalledWith(SESSION);
  });

  it("asks for permission when push is on but this install was never asked, then registers", async () => {
    // iOS keeps the saved token after the app is deleted, so a new install
    // starts with push on and no permission.
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue(notAsked);

    await expect(syncPushRegistration(SESSION)).resolves.toBe("registered");

    expect(Notifications.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockEnablePush).toHaveBeenCalledWith(SESSION);
  });

  it("turns push off when the owner declines the prompt, so the switch shows what the phone can get", async () => {
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue(notAsked);
    jest.mocked(Notifications.requestPermissionsAsync).mockResolvedValue(refused);

    await expect(syncPushRegistration(SESSION)).resolves.toBe("denied");

    expect(mockDisablePush).toHaveBeenCalledWith(SESSION);
    expect(mockEnablePush).not.toHaveBeenCalled();
  });

  it("does not ask again once notifications are turned off in the system settings", async () => {
    jest.mocked(Notifications.getPermissionsAsync).mockResolvedValue(refused);

    await expect(syncPushRegistration(SESSION)).resolves.toBe("denied");

    expect(Notifications.requestPermissionsAsync).not.toHaveBeenCalled();
    expect(mockDisablePush).toHaveBeenCalledWith(SESSION);
  });
});

describe("queuePushChange", () => {
  it("lets a switch change finish before re-registering, so the sync cannot undo it", async () => {
    let finishTurningOff: () => void = () => {};
    const turningOff = queuePushChange(() => new Promise<void>((resolve) => {
      finishTurningOff = () => {
        mockIsPushOn.mockResolvedValue(false);
        resolve();
      };
    }));

    const sync = syncPushRegistration(SESSION);
    await act(async () => {});
    expect(mockIsPushOn).not.toHaveBeenCalled();

    finishTurningOff();
    await turningOff;
    await expect(sync).resolves.toBe("off");
    expect(mockEnablePush).not.toHaveBeenCalled();
  });

  it("stops waiting for a change that never finishes, so the switch is never stuck", async () => {
    jest.useFakeTimers();
    try {
      void queuePushChange(() => new Promise<void>(() => {}));
      const sync = syncPushRegistration(SESSION);

      await jest.advanceTimersByTimeAsync(19_000);
      expect(mockIsPushOn).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1_000);

      await expect(sync).resolves.toBe("registered");
    } finally {
      jest.useRealTimers();
    }
  });

  it("keeps going after a change that failed", async () => {
    await expect(queuePushChange(() => Promise.reject(new Error("offline")))).rejects.toThrow("offline");

    await expect(syncPushRegistration(SESSION)).resolves.toBe("registered");
  });
});

describe("PushRegistrationSync", () => {
  let appStateListener: ((state: AppStateStatus) => void) | undefined;
  const removeAppStateListener = jest.fn();

  beforeEach(() => {
    appStateListener = undefined;
    jest.spyOn(AppState, "addEventListener").mockImplementation((_type, listener) => {
      appStateListener = listener as (state: AppStateStatus) => void;
      return { remove: removeAppStateListener } as ReturnType<typeof AppState.addEventListener>;
    });
  });

  afterEach(() => {
    jest.mocked(AppState.addEventListener).mockRestore();
  });

  it("registers once the computer is known, and again each time the app comes back", async () => {
    render(<PushRegistrationSync />);
    await act(async () => {});
    expect(mockEnablePush).toHaveBeenCalledTimes(1);

    await act(async () => appStateListener?.("background"));
    expect(mockEnablePush).toHaveBeenCalledTimes(1);

    await act(async () => appStateListener?.("active"));
    expect(mockEnablePush).toHaveBeenCalledTimes(2);
    expect(mockEnablePush).toHaveBeenLastCalledWith(SESSION);
  });

  it("waits for a computer before registering", async () => {
    mockGateway.gatewayUrl = null;

    render(<PushRegistrationSync />);
    await act(async () => {});

    expect(mockIsPushOn).not.toHaveBeenCalled();
    expect(mockEnablePush).not.toHaveBeenCalled();
  });

  it("does not start a second registration while one is still running", async () => {
    let finish: () => void = () => {};
    mockEnablePush.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));

    render(<PushRegistrationSync />);
    await act(async () => {});
    await act(async () => appStateListener?.("active"));
    expect(mockEnablePush).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await act(async () => appStateListener?.("active"));
    expect(mockEnablePush).toHaveBeenCalledTimes(2);
    await act(async () => finish());
  });

  it("logs a failed registration without throwing, and stops listening once unmounted", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockEnablePush.mockRejectedValue(new Error("Push notification settings could not be saved. Try again."));

    const view = render(<PushRegistrationSync />);
    await act(async () => {});

    expect(warn).toHaveBeenCalledWith(
      "[mobile] Push registration failed:",
      "Push notification settings could not be saved. Try again.",
    );
    view.unmount();
    expect(removeAppStateListener).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});
