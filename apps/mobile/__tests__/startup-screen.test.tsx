import React from "react";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet, Text } from "react-native";

import { StartupScreen } from "../components/StartupScreen";

describe("startup screen", () => {
  it("shows the rabbit logo above the Matrix OS title and its status content", () => {
    render(
      <StartupScreen>
        <Text>Authenticating…</Text>
      </StartupScreen>,
    );

    expect(screen.getByLabelText("Matrix OS logo")).toBeTruthy();
    expect(screen.getByText("Matrix OS")).toBeTruthy();
    expect(screen.getByText("Authenticating…")).toBeTruthy();

    const tree = JSON.stringify(screen.toJSON());
    expect(tree.indexOf("startup-logo")).toBeGreaterThan(-1);
    expect(tree.indexOf("startup-logo")).toBeLessThan(tree.indexOf("Matrix OS\""));
    expect(tree.indexOf("Matrix OS\"")).toBeLessThan(tree.indexOf("Authenticating…"));
  });

  it("keeps the logo where the native splash screen draws it", () => {
    render(<StartupScreen />);

    // The native splash is a 100pt image at the center of the screen. The logo
    // matches it, and everything else hangs below without taking part in the
    // centering, so the rabbit does not move when the splash hands over.
    const logo = NativeStyleSheet.flatten(screen.getByTestId("startup-logo").props.style);
    expect(logo).toMatchObject({ width: 100, height: 100 });
    const details = NativeStyleSheet.flatten(screen.getByTestId("startup-details").props.style);
    expect(details).toMatchObject({ position: "absolute", top: 100 });
  });

  it("leaves the title out until its font has loaded", () => {
    render(<StartupScreen showTitle={false} />);

    expect(screen.getByLabelText("Matrix OS logo")).toBeTruthy();
    expect(screen.queryByText("Matrix OS")).toBeNull();
  });
});
