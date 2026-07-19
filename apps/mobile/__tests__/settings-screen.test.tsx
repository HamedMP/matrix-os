jest.mock("@clerk/clerk-expo", () => ({
  useAuth: () => ({ signOut: jest.fn() }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
}));

jest.mock("@/app/_layout", () => ({
  useGateway: () => ({ client: null, connectionState: "connected", gateway: null }),
}));

jest.mock("@/lib/auth", () => ({
  isBiometricAvailable: jest.fn().mockResolvedValue(false),
  getSupportedBiometricTypes: jest.fn().mockResolvedValue([]),
  getBiometricLabel: jest.fn().mockReturnValue("Biometric"),
}));

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { SettingsContent } from "../app/(tabs)/settings";

describe("SettingsContent", () => {
  it("delegates computer switching through its route callback", () => {
    const onSwitchComputer = jest.fn();

    render(
      <SettingsContent
        settings={{ biometricEnabled: false, theme: "system", notificationsEnabled: true }}
        channels={{}}
        systemInfo={null}
        aiProfile={null}
        biometricLabel="Face ID"
        biometricAvailable={false}
        refreshing={false}
        connectionState="connected"
        gatewayName="Matrix OS Cloud"
        gatewayUrl="https://app.matrix-os.com"
        onRefresh={jest.fn()}
        updateSetting={jest.fn()}
        onSwitchComputer={onSwitchComputer}
        onSignOut={jest.fn()}
      />,
    );

    fireEvent.press(screen.getByText("Switch computer"));

    expect(onSwitchComputer).toHaveBeenCalledTimes(1);
  });
});
