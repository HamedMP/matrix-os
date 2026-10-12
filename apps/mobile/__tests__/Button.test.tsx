import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { ActivityIndicator } from "react-native";

import { Button, type ButtonVariant } from "../components/ui/Button";
import { Icon } from "../components/ui/Icon";
import { AddIcon } from "../components/ui/icons";

import { flat, pressedStyle } from "./ui-test-utils";

describe("Button", () => {
  afterEach(cleanup);

  it("is a filled 44pt control with the medium label by default", () => {
    render(<Button label="Create" onPress={jest.fn()} />);

    const button = screen.getByRole("button", { name: "Create" });
    expect(flat(button)).toMatchObject({
      height: 44,
      minWidth: 44,
      borderRadius: 10,
      paddingHorizontal: 10,
      backgroundColor: "#171717",
    });
    expect(flat(screen.getByText("Create"))).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 14,
      lineHeight: 20,
      color: "#FAFAFA",
    });
  });

  it("draws no shadow and no border on the filled style", () => {
    render(<Button label="Create" onPress={jest.fn()} />);

    const style = flat(screen.getByRole("button", { name: "Create" }));
    expect(style.boxShadow).toBeUndefined();
    expect(style.shadowColor).toBeUndefined();
    expect(style.elevation).toBeUndefined();
    expect(style.borderWidth).toBeUndefined();
  });

  it.each<[ButtonVariant, Record<string, unknown>, string]>([
    ["filled", { backgroundColor: "#171717" }, "#FAFAFA"],
    ["outline", { backgroundColor: "#FFFFFF", borderWidth: 1, borderColor: "#E5E5E5" }, "#0A0A0A"],
    ["secondary", { backgroundColor: "#F5F5F5" }, "#171717"],
    ["text", {}, "#0A0A0A"],
  ])("colours the %s style from the control tokens", (variant, surface, labelColor) => {
    render(<Button label="Go" variant={variant} onPress={jest.fn()} />);

    expect(flat(screen.getByRole("button", { name: "Go" }))).toMatchObject(surface);
    expect(flat(screen.getByText("Go")).color).toBe(labelColor);
  });

  it("leaves the text style without a fill or a border", () => {
    render(<Button label="Cancel" variant="text" onPress={jest.fn()} />);

    const style = flat(screen.getByRole("button", { name: "Cancel" }));
    expect(style.backgroundColor).toBeUndefined();
    expect(style.borderWidth).toBeUndefined();
  });

  it("is 48pt high at the large size", () => {
    render(<Button label="Allow once" size="large" onPress={jest.fn()} />);

    expect(flat(screen.getByRole("button", { name: "Allow once" })).height).toBe(48);
  });

  it("leaves its width to its parent unless it is full width", () => {
    render(<Button label="Open" onPress={jest.fn()} />);
    expect(flat(screen.getByRole("button", { name: "Open" })).alignSelf).toBeUndefined();
    cleanup();

    render(<Button label="Create agent" fullWidth onPress={jest.fn()} />);
    expect(flat(screen.getByRole("button", { name: "Create agent" })).alignSelf).toBe("stretch");
  });

  it("puts a 16pt icon in the label colour before the label, 6pt apart", () => {
    render(<Button label="New agent" variant="secondary" icon={AddIcon} onPress={jest.fn()} testID="new-agent" />);

    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({
      icon: AddIcon,
      size: 16,
      color: "#171717",
    });
    expect(flat(screen.getByTestId("new-agent-content"))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    });
  });

  it("calls onPress when pressed", () => {
    const onPress = jest.fn();
    render(<Button label="Save" onPress={onPress} />);

    fireEvent.press(screen.getByRole("button", { name: "Save" }));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("dims to 0.65 while pressed", () => {
    render(<Button label="Save" onPress={jest.fn()} />);

    expect(pressedStyle({ accessibilityRole: "button" }).opacity).toBe(0.65);
    expect(flat(screen.getByRole("button", { name: "Save" })).opacity).toBeUndefined();
  });

  it("dims to 0.5 and ignores presses when disabled", () => {
    const onPress = jest.fn();
    render(<Button label="Create" disabled onPress={onPress} />);

    const button = screen.getByRole("button", { name: "Create" });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(flat(button).opacity).toBe(0.5);
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: false });
  });

  it("shows a spinner in the label colour and ignores presses while loading", () => {
    const onPress = jest.fn();
    render(<Button label="Save" loading onPress={onPress} testID="save" />);

    const button = screen.getByRole("button", { name: "Save" });
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(screen.UNSAFE_getByType(ActivityIndicator).props.color).toBe("#FAFAFA");
    expect(button.props.accessibilityState).toMatchObject({ disabled: true, busy: true });
    // The label keeps its place so the button does not change width.
    expect(flat(screen.getByTestId("save-content")).opacity).toBe(0);
    expect(flat(button).opacity).toBeUndefined();
  });

  it("uses an explicit accessibility label when one is given", () => {
    render(<Button label="Open" accessibilityLabel="Open Northwind brief" onPress={jest.fn()} />);

    expect(screen.getByLabelText("Open Northwind brief").props.accessibilityRole).toBe("button");
  });
});
