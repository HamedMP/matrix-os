import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

jest.mock("@clerk/clerk-expo", () => ({
  useUser: () => ({
    isLoaded: true,
    user: {
      firstName: "Shubham",
      fullName: "Shubham Zanwar",
      username: "shubham",
    },
  }),
}));

import MockHomeScreen from "../app/(drawer)/index";

describe("drawer home screen", () => {
  it("uses the Matrix rabbit artwork for its empty-state mark", () => {
    render(<MockHomeScreen />);

    expect(screen.getByText("Welcome back Shubham")).toBeTruthy();
    expect(screen.queryByText("Ask Matrix, open the drawer, or continue something recent.")).toBeNull();
    const rabbitStyle = NativeStyleSheet.flatten(
      screen.getByTestId("home-rabbit-mark").props.style,
    );
    expect(rabbitStyle).toMatchObject({ width: 68, height: 68 });
    const containerStyle = NativeStyleSheet.flatten(
      screen.getByTestId("home-rabbit-container").props.style,
    );
    expect(containerStyle.borderWidth).toBeUndefined();
    expect(containerStyle.backgroundColor).toBeUndefined();
    expect(containerStyle).toMatchObject({ width: 68, height: 68 });
  });
});
