const mockPush = jest.fn();

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import IntegrationsScreen from "../app/(drawer)/integrations";

describe("mock integrations screen", () => {
  it("uses spacers instead of vertical padding or margins", () => {
    render(<IntegrationsScreen />);

    const styles = [
      screen.getByLabelText("View installed integrations").props.style,
      screen.getByText("4 connected services").props.style,
      screen.getByText("AVAILABLE").props.style,
      screen.getByLabelText("Open GitHub").props.style,
    ].map(NativeStyleSheet.flatten);

    for (const style of styles) {
      expect(style.paddingTop).toBeUndefined();
      expect(style.paddingBottom).toBeUndefined();
      expect(style.paddingVertical).toBeUndefined();
      expect(style.marginTop).toBeUndefined();
      expect(style.marginBottom).toBeUndefined();
      expect(style.marginVertical).toBeUndefined();
    }
  });
});
