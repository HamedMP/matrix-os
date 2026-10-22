import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { View } from "react-native";

import { Chip } from "../components/ui/Chip";

import { flat, pressedStyle } from "./ui-test-utils";

describe("Chip", () => {
  afterEach(cleanup);

  it("is a 36pt grey pill with no border when unselected", () => {
    render(<Chip label="Sales" onPress={jest.fn()} />);

    const chip = screen.getByRole("button", { name: "Sales" });
    const style = flat(chip);
    expect(style).toMatchObject({
      height: 36,
      paddingHorizontal: 12,
      borderRadius: 9999,
      backgroundColor: "#F2F2F0",
    });
    expect(style.borderWidth).toBeUndefined();
    expect(flat(screen.getByText("Sales"))).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 13,
      lineHeight: 18,
      color: "#242323",
    });
    expect(chip.props.accessibilityState).toMatchObject({ selected: false });
  });

  it("inverts when selected and reports it to assistive technology", () => {
    render(<Chip label="All" selected onPress={jest.fn()} />);

    const chip = screen.getByRole("button", { name: "All" });
    expect(flat(chip).backgroundColor).toBe("#0D0D0D");
    expect(flat(screen.getByText("All")).color).toBe("#FFFFFF");
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
  });

  it("places a leading node 6pt before the label", () => {
    render(
      <Chip label="Codex" leading={<View testID="codex-logo" />} onPress={jest.fn()} />,
    );

    expect(screen.getByTestId("codex-logo")).toBeTruthy();
    expect(flat(screen.getByRole("button", { name: "Codex" }))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    });
  });

  it("extends its tap area to 44pt without growing wider than its label needs", () => {
    render(<Chip label="All" onPress={jest.fn()} />);

    const chip = screen.getByRole("button", { name: "All" });
    const style = flat(chip);
    const slop = chip.props.hitSlop as number;
    expect((style.height as number) + slop * 2).toBe(44);
    // "All" is drawn 40pt wide: the slop, not a minimum width, covers the rest.
    expect(40 + slop * 2).toBeGreaterThanOrEqual(44);
    expect(style.minWidth).toBeUndefined();
    expect(style.width).toBeUndefined();
  });

  it("calls onPress when pressed and dims to 0.65 while pressed", () => {
    const onPress = jest.fn();
    render(<Chip label="Ops" onPress={onPress} />);

    fireEvent.press(screen.getByRole("button", { name: "Ops" }));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(pressedStyle({ accessibilityRole: "button" }).opacity).toBe(0.65);
  });

  it("dims to 0.5 and ignores presses when disabled", () => {
    const onPress = jest.fn();
    render(<Chip label="Ops" disabled onPress={onPress} />);

    const chip = screen.getByRole("button", { name: "Ops" });
    fireEvent.press(chip);
    expect(onPress).not.toHaveBeenCalled();
    expect(flat(chip).opacity).toBe(0.5);
    expect(chip.props.accessibilityState).toMatchObject({ disabled: true });
  });
});
