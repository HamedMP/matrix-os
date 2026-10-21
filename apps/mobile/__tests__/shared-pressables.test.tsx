import { fireEvent, render, screen } from "@testing-library/react-native";

import { SettingsRow } from "../components/settings/SettingsSurface";
import { GridTile, ListRow } from "../components/shell/Controls";
import { motion } from "../lib/theme-v2";

import { heldScale } from "./ui-test-utils";

describe("shared rows and tiles", () => {
  it("shrinks an app tile like a button while it is held", () => {
    const onPress = jest.fn();
    render(<GridTile label="Notes" onPress={onPress} />);

    expect(heldScale({ accessibilityLabel: "Open Notes" })).toBe(motion.pressScale);
    fireEvent.press(screen.getByRole("button", { name: "Open Notes" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("leaves a tile with nothing to open disabled", () => {
    render(<GridTile label="Notes" />);

    expect(screen.getByLabelText("Open Notes").props.accessibilityState).toMatchObject({ disabled: true });
  });

  it("gives a list row and a settings row the gentler row scale", () => {
    render(
      <>
        <ListRow title="Gmail" onPress={jest.fn()} />
        <SettingsRow title="Account" onPress={jest.fn()} />
      </>,
    );

    expect(heldScale({ accessibilityLabel: "Open Gmail" })).toBe(motion.rowPressScale);
    expect(heldScale({ accessibilityLabel: "Open Account" })).toBe(motion.rowPressScale);
  });

  it("draws rows with nothing to do as plain views", () => {
    render(
      <>
        <ListRow title="Gmail" />
        <SettingsRow title="Account" />
      </>,
    );

    expect(screen.queryByRole("button")).toBeNull();
  });
});
