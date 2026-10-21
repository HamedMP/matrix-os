import Add01Icon from "@hugeicons/core-free-icons/Add01Icon";
import { render, screen } from "@testing-library/react-native";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { IconButton } from "../components/ui/IconButton";

import { pressedStyle } from "./ui-test-utils";

describe("IconButton", () => {
  it("is transparent by default", () => {
    render(<IconButton accessibilityLabel="Add" icon={Add01Icon} />);

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Add").props.style)).toMatchObject({
      backgroundColor: "transparent",
    });
  });

  it("accepts an explicit background color", () => {
    render(
      <IconButton
        accessibilityLabel="Add"
        icon={Add01Icon}
        backgroundColor="#2B3715"
      />,
    );

    expect(NativeStyleSheet.flatten(screen.getByLabelText("Add").props.style)).toMatchObject({
      backgroundColor: "#2B3715",
    });
  });

  it("replaces its icon with a spinner while loading", () => {
    render(
      <IconButton
        accessibilityLabel="Add"
        icon={Add01Icon}
        iconTestID="add-icon"
        loading
        loadingTestID="add-loading"
      />,
    );

    expect(screen.getByTestId("add-loading")).toBeTruthy();
    expect(screen.queryByTestId("add-icon")).toBeNull();
    expect(screen.getByLabelText("Add").props.accessibilityState).toMatchObject({
      busy: true,
      disabled: true,
    });
  });

  it("reaches a 44pt touch target when it is drawn smaller", () => {
    render(<IconButton accessibilityLabel="Close" icon={Add01Icon} buttonSize={32} onPress={jest.fn()} />);

    expect(32 + 2 * (screen.getByLabelText("Close").props.hitSlop as number)).toBe(44);
  });

  it("needs no extra reach at full size, and keeps one it is given", () => {
    render(<IconButton accessibilityLabel="Add" icon={Add01Icon} buttonSize={44} onPress={jest.fn()} />);
    expect(screen.getByLabelText("Add").props.hitSlop).toBeUndefined();

    render(<IconButton accessibilityLabel="Clear" icon={Add01Icon} buttonSize={32} hitSlop={10} onPress={jest.fn()} />);
    expect(screen.getByLabelText("Clear").props.hitSlop).toBe(10);
  });

  it("dims while pressed", () => {
    render(<IconButton accessibilityLabel="Close" icon={Add01Icon} buttonSize={32} onPress={jest.fn()} />);

    expect(pressedStyle({ accessibilityLabel: "Close" }).opacity).toBe(0.65);
  });
});
