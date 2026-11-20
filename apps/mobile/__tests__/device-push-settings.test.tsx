import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";
import * as Notifications from "expo-notifications";

import { DevicePushSettings } from "../components/settings/DevicePushSettings";
import { disablePushNotifications, isPushNotificationsEnabled } from "@/lib/push";
import { queuePushChange, syncPushRegistration } from "@/lib/push-registration-sync";
import { fetchActiveComputer } from "@/lib/requests";

import { disposeTestQueryClient } from "./query-test-cleanup";

let mockUserId = "user_1";
const mockEnablePush = jest.fn(() => Promise.resolve(true));

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: async () => "clerk-token", isLoaded: true, isSignedIn: true, userId: mockUserId }),
}));

jest.mock("@/lib/push", () => ({
  disablePushNotifications: jest.fn(() => Promise.resolve()),
  enablePushNotifications: () => mockEnablePush(),
  isPushNotificationsEnabled: jest.fn(() => Promise.resolve(false)),
}));

jest.mock("@/lib/requests", () => ({
  fetchActiveComputer: jest.fn(() => Promise.resolve({ handle: "amin", runtimeSlot: "primary", gatewayPath: "/vm/amin" })),
  mobileQueryKeys: { activeComputer: (userId: string) => ["active-computer", userId] },
}));

jest.mock("@/lib/storage", () => ({
  HOSTED_GATEWAY_URL: "https://app.example.test",
}));

describe("Device push settings", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    mockUserId = "user_1";
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    jest.mocked(Haptics.selectionAsync).mockClear();
    mockEnablePush.mockClear();
    jest.mocked(isPushNotificationsEnabled).mockResolvedValue(false);
    jest.mocked(disablePushNotifications).mockClear();
  });

  afterEach(async () => {
    // Unmount before the cache goes: a screen still mounted would schedule new cache timers as it unmounts.
    cleanup();
    await disposeTestQueryClient(queryClient);
  });

  function renderScreen() {
    return render(
      <QueryClientProvider client={queryClient}>
        <DevicePushSettings />
      </QueryClientProvider>,
    );
  }

  async function findEnabledSwitch(name: string) {
    const row = await screen.findByRole("switch", { name });
    await waitFor(() => expect(row.props.accessibilityState?.disabled).toBeFalsy());
    return row;
  }

  it("turns push on from a tap on its switch, with the selection tick", async () => {
    renderScreen();
    const push = await findEnabledSwitch("Push notifications");
    expect(push.props.accessibilityState).toMatchObject({ checked: false });

    fireEvent.press(push);

    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: true }));
    expect(mockEnablePush).toHaveBeenCalledTimes(1);
  });

  it("shows push on as soon as its switch is tapped, while the computer answers", async () => {
    let answer: () => void = () => {};
    mockEnablePush.mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = () => resolve(true); }));
    renderScreen();
    const push = await findEnabledSwitch("Push notifications");

    fireEvent.press(push);

    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: true, disabled: true });
    await waitFor(() => expect(mockEnablePush).toHaveBeenCalledTimes(1));
    await act(async () => answer());
    await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: true, disabled: false }));
  });

  it("waits for a push registration already under way before changing push", async () => {
    let finishRegistering: () => void = () => {};
    const registering = queuePushChange(() => new Promise<void>((resolve) => { finishRegistering = resolve; }));
    renderScreen();
    const push = await findEnabledSwitch("Push notifications");

    fireEvent.press(push);
    await act(async () => {});
    expect(mockEnablePush).not.toHaveBeenCalled();

    await act(async () => {
      finishRegistering();
      await registering;
    });
    await waitFor(() => expect(mockEnablePush).toHaveBeenCalledTimes(1));
  });

  it("shows push off once re-registration turns it off while the screen is open", async () => {
    jest.mocked(isPushNotificationsEnabled).mockResolvedValue(true);
    jest.mocked(Notifications.getPermissionsAsync)
      .mockResolvedValueOnce({ granted: false, status: "denied", canAskAgain: false } as Notifications.NotificationPermissionsStatus);
    try {
      renderScreen();
      const push = await findEnabledSwitch("Push notifications");
      expect(push.props.accessibilityState).toMatchObject({ checked: true });

      await act(async () => {
        await expect(syncPushRegistration({ clerkToken: "clerk-token", gatewayUrl: "https://app.example.test/vm/amin" }))
          .resolves.toBe("denied");
      });

      expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
        .toMatchObject({ checked: false });
    } finally {
      jest.mocked(isPushNotificationsEnabled).mockResolvedValue(false);
    }
  });

  it("puts the push switch back when push cannot be turned on", async () => {

    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockEnablePush.mockImplementationOnce(() => Promise.reject(new Error("Push notification permission was not granted.")));
    renderScreen();
    const push = await findEnabledSwitch("Push notifications");

    fireEvent.press(push);

    await screen.findByText(/Couldn’t update push notifications/);
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: false, disabled: false });
    warn.mockRestore();
  });

  it("leaves the switch alone when the row's text is tapped", async () => {
    renderScreen();
    await findEnabledSwitch("Push notifications");

    fireEvent.press(screen.getByText("Push notifications"));
    fireEvent.press(screen.getByText("Allow this phone to receive notifications from this computer"));

    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: false });
    expect(Haptics.selectionAsync).not.toHaveBeenCalled();
    expect(mockEnablePush).not.toHaveBeenCalled();
  });

  it("keeps the push row off until a computer is connected", async () => {
    jest.mocked(fetchActiveComputer).mockRejectedValueOnce(new Error("Computer unavailable."));
    renderScreen();
    const push = await screen.findByRole("switch", { name: "Push notifications" });
    await screen.findByText("Connect a computer to enable");

    fireEvent.press(push);

    expect(push.props.accessibilityState).toMatchObject({ disabled: true, checked: false });
    expect(mockEnablePush).not.toHaveBeenCalled();
  });
  it("queues device disable and preserves the enabled value when it fails", async () => {
    jest.mocked(isPushNotificationsEnabled).mockResolvedValue(true);
    jest.mocked(disablePushNotifications).mockRejectedValueOnce(new Error("unavailable"));
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    let release!: () => void;
    const queued = queuePushChange(() => new Promise<void>((done) => { release = done; }));
    renderScreen();
    fireEvent.press(await findEnabledSwitch("Push notifications"));
    await act(async () => {});
    expect(disablePushNotifications).not.toHaveBeenCalled();
    await act(async () => { release(); await queued; });
    await screen.findByText(/Couldn’t update push notifications/);
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState).toMatchObject({ checked: true });
    fireEvent.press(screen.getByRole("switch", { name: "Push notifications" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: false, disabled: false }));
    warn.mockRestore();
  });

  it("ignores a prior computer's completed enable operation", async () => {
    let finish!: () => void;
    mockEnablePush.mockImplementationOnce(() => new Promise<boolean>((done) => { finish = () => done(true); }));
    renderScreen();
    fireEvent.press(await findEnabledSwitch("Push notifications"));
    await waitFor(() => expect(mockEnablePush).toHaveBeenCalledTimes(1));
    await act(async () => {
      queryClient.setQueryData(["active-computer", "user_1"], { handle: "other", runtimeSlot: "primary", gatewayPath: "/vm/other" });
    });
    await findEnabledSwitch("Push notifications");
    await act(async () => finish());
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState).toMatchObject({ checked: false });
  });
  it("ignores a completed enable after changing signed-in accounts", async () => {
    let finish!: () => void;
    mockEnablePush.mockImplementationOnce(() => new Promise<boolean>((done) => { finish = () => done(true); }));
    const view = renderScreen();
    fireEvent.press(await findEnabledSwitch("Push notifications"));
    await waitFor(() => expect(mockEnablePush).toHaveBeenCalledTimes(1));
    mockUserId = "user_2";
    view.rerender(<QueryClientProvider client={queryClient}><DevicePushSettings /></QueryClientProvider>);
    await findEnabledSwitch("Push notifications");
    await act(async () => finish());
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState).toMatchObject({ checked: false });
  });
});
