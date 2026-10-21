import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Haptics from "expo-haptics";

import AppSettingsScreen from "../app/settings-detail/app-settings";

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
  });

  afterEach(async () => {
    // Unmount before the cache goes: a screen still mounted would schedule new cache timers as it unmounts.
    cleanup();
    await disposeTestQueryClient(queryClient);
  });

  it("plays the selection tick as a switch is flipped", async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <AppSettingsScreen />
      </QueryClientProvider>,
    );
    const push = await screen.findByLabelText("Push notifications");
    await waitFor(() => expect(push.props.disabled).toBeFalsy());

    fireEvent(push, "valueChange", true);

    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.getByLabelText("Push notifications").props.value).toBe(true));
    expect(mockEnablePush).toHaveBeenCalledTimes(1);
  });
});
