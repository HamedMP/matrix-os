import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert } from "react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import AppSettingsScreen from "../app/settings-detail/app-settings";
import { queuePushChange } from "@/lib/push-registration-sync";
import { fetchActiveComputer } from "@/lib/requests";

import { disposeTestQueryClient } from "./query-test-cleanup";

const mockEnablePush = jest.fn(() => Promise.resolve(true));
const mockSaveSettings = jest.fn(() => Promise.resolve());

jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ getToken: async () => "clerk-token", isLoaded: true, isSignedIn: true, userId: "user_1" }),
}));

jest.mock("@/lib/auth", () => ({
  authenticateBiometricNow: jest.fn(() => Promise.resolve(true)),
  getBiometricLabel: () => "Face ID",
  getSupportedBiometricTypes: jest.fn(() => Promise.resolve([])),
  isBiometricAvailable: jest.fn(() => Promise.resolve(true)),
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
  getSettings: jest.fn(() => Promise.resolve({ biometricEnabled: false, theme: "system", notificationsEnabled: false })),
  saveSettings: () => mockSaveSettings(),
}));

describe("App settings", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    jest.mocked(Haptics.selectionAsync).mockClear();
    mockEnablePush.mockClear();
    mockSaveSettings.mockClear();
  });

  afterEach(async () => {
    // Unmount before the cache goes: a screen still mounted would schedule new cache timers as it unmounts.
    cleanup();
    await disposeTestQueryClient(queryClient);
  });

  function renderScreen() {
    render(
      <QueryClientProvider client={queryClient}>
        <AppSettingsScreen />
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

  it("puts the push switch back when push cannot be turned on", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    mockEnablePush.mockImplementationOnce(() => Promise.reject(new Error("Push notification permission was not granted.")));
    renderScreen();
    const push = await findEnabledSwitch("Push notifications");

    fireEvent.press(push);

    await waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("switch", { name: "Push notifications" }).props.accessibilityState)
      .toMatchObject({ checked: false, disabled: false });
    alert.mockRestore();
    warn.mockRestore();
  });

  it("turns the biometric lock on from a tap on its switch", async () => {
    renderScreen();
    const biometric = await findEnabledSwitch("Face ID lock");

    fireEvent.press(biometric);

    await waitFor(() => expect(screen.getByRole("switch", { name: "Face ID lock" }).props.accessibilityState)
      .toMatchObject({ checked: true }));
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });

  it("leaves the switch alone when the row's text is tapped", async () => {
    renderScreen();
    await findEnabledSwitch("Push notifications");

    fireEvent.press(screen.getByText("Push notifications"));
    fireEvent.press(screen.getByText("Notifications from this computer"));

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
});
