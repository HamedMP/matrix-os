import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { View } from "react-native";

import { ItemRow } from "../components/ui/ItemRow";

import { flat, pressedStyle } from "./ui-test-utils";

describe("ItemRow", () => {
  afterEach(cleanup);

  it("sets the title in 16pt medium over a 13pt subtle subtitle, 2pt apart, one line each", () => {
    render(<ItemRow testID="row" title="Account research" subtitle="Waiting for your approval" />);

    const title = screen.getByText("Account research");
    expect(flat(title)).toMatchObject({
      fontFamily: "Geist_500Medium",
      fontSize: 16,
      lineHeight: 22,
      color: "#242323",
    });
    expect(title.props.numberOfLines).toBe(1);
    const subtitle = screen.getByText("Waiting for your approval");
    expect(flat(subtitle)).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 13,
      lineHeight: 18,
      color: "#635F5F",
      marginTop: 2,
    });
    expect(subtitle.props.numberOfLines).toBe(1);
  });

  it("is 62pt high when compact: 10pt padding around the two lines", () => {
    render(<ItemRow testID="row" title="Case study" subtitle="Draft ready to review" />);

    const row = flat(screen.getByTestId("row"));
    const title = flat(screen.getByText("Case study"));
    const subtitle = flat(screen.getByText("Draft ready to review"));
    expect(row).toMatchObject({ flexDirection: "row", alignItems: "center", paddingVertical: 10 });
    expect(
      (row.paddingVertical as number) * 2
        + (title.lineHeight as number)
        + (subtitle.marginTop as number)
        + (subtitle.lineHeight as number),
    ).toBe(62);
  });

  it("uses 12pt padding when comfortable", () => {
    render(<ItemRow testID="row" density="comfortable" title="Portfolio" subtitle="Updated today" />);

    expect(flat(screen.getByTestId("row")).paddingVertical).toBe(12);
  });

  it("puts the leading node 12pt before the text by default, or at the given step", () => {
    render(<ItemRow testID="row" title="Portfolio" leading={<View testID="tile" />} />);
    expect(screen.getByTestId("tile")).toBeTruthy();
    expect(flat(screen.getByTestId("row-leading")).marginRight).toBe(12);
    cleanup();

    render(<ItemRow testID="row" gap={14} title="Portfolio" leading={<View testID="tile" />} />);
    expect(flat(screen.getByTestId("row-leading")).marginRight).toBe(14);
  });

  it("puts the title accessory 6pt after the title", () => {
    render(<ItemRow testID="row" title="My inbox" titleAccessory={<View testID="dot" />} />);

    expect(screen.getByTestId("dot")).toBeTruthy();
    expect(flat(screen.getByTestId("row-title-line"))).toMatchObject({
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    });
  });

  it("top-aligns the time at the right in the tertiary footnote style", () => {
    render(<ItemRow testID="row" title="Q4 planning" subtitle="Draft shared with the team" meta="Mon" />);

    expect(flat(screen.getByText("Mon"))).toMatchObject({
      alignSelf: "flex-start",
      fontFamily: "Geist_400Regular",
      fontSize: 12,
      lineHeight: 17,
      color: "#8A8686",
    });
  });

  it("renders a trailing node after the text", () => {
    render(<ItemRow testID="row" title="Portfolio" trailing={<View testID="chevron" />} />);

    expect(screen.getByTestId("chevron")).toBeTruthy();
  });

  it("is a button that fires onPress and onLongPress", () => {
    const onPress = jest.fn();
    const onLongPress = jest.fn();
    render(<ItemRow testID="row" title="Case study" subtitle="Draft ready" onPress={onPress} onLongPress={onLongPress} />);

    const row = screen.getByTestId("row");
    expect(row.props.accessibilityRole).toBe("button");
    fireEvent.press(row);
    expect(onPress).toHaveBeenCalledTimes(1);
    fireEvent(row, "longPress");
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it("dims to 0.65 while pressed", () => {
    render(<ItemRow testID="row" title="Case study" onPress={jest.fn()} />);

    expect(pressedStyle({ testID: "row" }).opacity).toBe(0.65);
  });

  it("is not a button when it has nothing to do", () => {
    render(<ItemRow testID="row" title="Case study" />);

    expect(screen.getByTestId("row").props.accessibilityRole).toBeUndefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("takes an accessibility label", () => {
    render(<ItemRow title="Case study" accessibilityLabel="Open Case study" onPress={jest.fn()} />);

    expect(screen.getByLabelText("Open Case study").props.accessibilityRole).toBe("button");
  });
});
