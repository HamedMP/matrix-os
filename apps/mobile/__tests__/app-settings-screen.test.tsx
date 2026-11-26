import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AppSettingsScreen from "../app/settings-detail/app-settings";

const mockPushRoute = jest.fn();
const mockSaveSettings = jest.fn(() => Promise.resolve());
jest.mock("expo-router", () => ({ useRouter: () => ({ push: mockPushRoute }) }));
jest.mock("@/lib/auth", () => ({
  authenticateBiometricNow: jest.fn(() => Promise.resolve(true)),
  getBiometricLabel: () => "Face ID",
  getSupportedBiometricTypes: jest.fn(() => Promise.resolve([])),
  isBiometricAvailable: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("@/lib/storage", () => ({
  getSettings: jest.fn(() => Promise.resolve({ biometricEnabled: false, theme: "system", notificationsEnabled: false })),
  saveSettings: () => mockSaveSettings(),
}));

describe("App settings", () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(cleanup);

  it("opens notification preferences even when this phone has push off", async () => {
    render(<AppSettingsScreen />);
    fireEvent.press(await screen.findByRole("button", { name: "Open Push notifications" }));
    expect(mockPushRoute).toHaveBeenCalledWith("/settings-detail/notifications");
  });

  it("turns the biometric lock on from a tap on its switch", async () => {
    render(<AppSettingsScreen />);
    const biometric = await screen.findByRole("switch", { name: "Face ID lock" });
    fireEvent.press(biometric);
    await waitFor(() => expect(screen.getByRole("switch", { name: "Face ID lock" }).props.accessibilityState)
      .toMatchObject({ checked: true }));
    expect(mockSaveSettings).toHaveBeenCalledTimes(1);
  });
});
