import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { View } from "react-native";

import { Icon } from "../components/ui/Icon";
import { BackIcon, InfoIcon } from "../components/ui/icons";
import { TopBar, TopBarButton } from "../components/ui/TopBar";

import { flat, pressedStyle } from "./ui-test-utils";

describe("TopBar", () => {
  afterEach(cleanup);

  it("is a 52pt row with 8pt side padding and no bottom border", () => {
    render(<TopBar testID="bar" title="New chat" />);

    const style = flat(screen.getByTestId("bar"));
    expect(style).toMatchObject({
      height: 52,
      paddingHorizontal: 8,
      flexDirection: "row",
      alignItems: "center",
    });
    expect(style.borderBottomWidth).toBeUndefined();
    expect(style.paddingTop).toBeUndefined();
  });

  it("centres a one-line semibold title between two 44pt slots", () => {
    render(
      <TopBar
        testID="bar"
        title="Portfolio"
        leading={<View testID="back" />}
      />,
    );

    const title = screen.getByRole("header", { name: "Portfolio" });
    expect(flat(title)).toMatchObject({
      flex: 1,
      textAlign: "center",
      fontFamily: "Geist_600SemiBold",
      fontSize: 16,
      lineHeight: 22,
      color: "#242323",
    });
    expect(title.props.numberOfLines).toBe(1);
    expect(screen.getByTestId("back")).toBeTruthy();
    // The empty trailing slot keeps the title centred.
    expect(flat(screen.getByTestId("bar-leading")).minWidth).toBe(44);
    expect(flat(screen.getByTestId("bar-trailing")).minWidth).toBe(44);
  });

  it("keeps both slots when there is no title", () => {
    render(<TopBar testID="bar" trailing={<View testID="new-project" />} />);

    expect(screen.queryByRole("header")).toBeNull();
    expect(screen.getByTestId("bar-leading")).toBeTruthy();
    expect(screen.getByTestId("new-project")).toBeTruthy();
  });

  it("lays the start-aligned form out as leading node, title over subtitle, 10pt apart", () => {
    render(
      <TopBar
        testID="bar"
        align="start"
        title="Account research"
        subtitle="Runs before each meeting"
        titleLeading={<View testID="mascot" />}
        leading={<View testID="back" />}
        trailing={<View testID="info" />}
      />,
    );

    expect(flat(screen.getByTestId("bar")).gap).toBe(10);
    expect(screen.getByTestId("mascot")).toBeTruthy();
    const title = screen.getByRole("header", { name: "Account research" });
    expect(flat(title)).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 16,
      lineHeight: 22,
      color: "#242323",
    });
    expect(flat(title).textAlign).toBeUndefined();
    const subtitle = screen.getByText("Runs before each meeting");
    expect(flat(subtitle)).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 12,
      lineHeight: 17,
      color: "#635F5F",
    });
    expect(subtitle.props.numberOfLines).toBe(1);
  });

  it("has no gap between the slots and a centred title", () => {
    render(<TopBar testID="bar" title="New chat" />);

    expect(flat(screen.getByTestId("bar")).gap).toBeUndefined();
  });
});

describe("TopBarButton", () => {
  afterEach(cleanup);

  it("is a 44pt transparent button with a 20pt icon", () => {
    render(<TopBarButton icon={BackIcon} accessibilityLabel="Back" onPress={jest.fn()} />);

    const button = screen.getByLabelText("Back");
    expect(button.props.accessibilityRole).toBe("button");
    expect(flat(button)).toMatchObject({
      width: 44,
      height: 44,
      backgroundColor: "transparent",
    });
    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({ icon: BackIcon, size: 20 });
  });

  it("takes an icon size", () => {
    render(<TopBarButton icon={BackIcon} iconSize={22} accessibilityLabel="Back" onPress={jest.fn()} />);

    expect(screen.UNSAFE_getByType(Icon).props.size).toBe(22);
  });

  it("is a round card-coloured button when filled", () => {
    render(<TopBarButton icon={InfoIcon} filled accessibilityLabel="Agent details" onPress={jest.fn()} />);

    expect(flat(screen.getByLabelText("Agent details"))).toMatchObject({
      width: 44,
      height: 44,
      borderRadius: 9999,
      backgroundColor: "#FAF9F7",
    });
  });

  it("calls onPress and dims to 0.65 while pressed", () => {
    const onPress = jest.fn();
    render(<TopBarButton icon={BackIcon} accessibilityLabel="Back" onPress={onPress} />);

    fireEvent.press(screen.getByLabelText("Back"));
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(pressedStyle({ accessibilityRole: "button" }).opacity).toBe(0.65);
  });

  it("dims to 0.5 and ignores presses when disabled", () => {
    const onPress = jest.fn();
    render(<TopBarButton icon={BackIcon} accessibilityLabel="Back" disabled onPress={onPress} />);

    const button = screen.getByLabelText("Back");
    fireEvent.press(button);
    expect(onPress).not.toHaveBeenCalled();
    expect(flat(button).opacity).toBe(0.5);
  });
});
