import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet, Text } from "react-native";
import * as Reanimated from "react-native-reanimated";

import { PressableScale } from "../components/ui/PressableScale";
import { PRESSED_OPACITY } from "../components/ui/pressable-state";
import { motion } from "../lib/theme-v2";

import { resetReduceMotion } from "./ui-test-utils";

function drawnStyle(testID: string) {
  return StyleSheet.flatten(screen.getByTestId(testID).props.style);
}

function Subject(props: Partial<React.ComponentProps<typeof PressableScale>>) {
  return (
    <PressableScale testID="subject" accessibilityRole="button" accessibilityLabel="Open" style={{ padding: 4 }} {...props}>
      <Text>Open</Text>
    </PressableScale>
  );
}

describe("PressableScale", () => {
  beforeEach(resetReduceMotion);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("shrinks a little while held and springs back when let go", () => {
    const spring = jest.spyOn(Reanimated, "withSpring");
    const view = render(<Subject />);
    expect(drawnStyle("subject").transform).toEqual([{ scale: 1 }]);

    fireEvent(screen.getByTestId("subject"), "pressIn");
    view.rerender(<Subject />);
    expect(drawnStyle("subject").transform).toEqual([{ scale: motion.pressScale }]);
    expect(spring).toHaveBeenLastCalledWith(1, motion.spring.snappy);

    fireEvent(screen.getByTestId("subject"), "pressOut");
    view.rerender(<Subject />);
    expect(drawnStyle("subject").transform).toEqual([{ scale: 1 }]);
    expect(spring).toHaveBeenLastCalledWith(0, motion.spring.snappy);
  });

  it("keeps the style it is given", () => {
    render(<Subject style={{ padding: 4, borderRadius: 12 }} />);
    expect(drawnStyle("subject")).toMatchObject({ padding: 4, borderRadius: 12 });
  });

  it("dims instead of moving when the person has asked for reduced motion", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const view = render(<Subject />);
    await act(async () => {});

    fireEvent(screen.getByTestId("subject"), "pressIn");
    view.rerender(<Subject />);

    const style = drawnStyle("subject");
    expect(style.transform).toBeUndefined();
    expect(style.opacity).toBeCloseTo(PRESSED_OPACITY);
  });

  it("keeps the caller's own opacity under the dimming, with reduced motion on", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const faded = { padding: 4, opacity: 0.5 };
    const view = render(<Subject style={faded} />);
    await act(async () => {});
    expect(drawnStyle("subject").opacity).toBeCloseTo(0.5);

    fireEvent(screen.getByTestId("subject"), "pressIn");
    view.rerender(<Subject style={faded} />);
    expect(drawnStyle("subject").opacity).toBeCloseTo(0.5 * PRESSED_OPACITY);
  });

  it("passes presses and the caller's own press-in and press-out through", () => {
    const onPress = jest.fn();
    const onPressIn = jest.fn();
    const onPressOut = jest.fn();
    render(<Subject onPress={onPress} onPressIn={onPressIn} onPressOut={onPressOut} />);

    fireEvent(screen.getByTestId("subject"), "pressIn");
    fireEvent(screen.getByTestId("subject"), "pressOut");
    fireEvent.press(screen.getByText("Open"));

    expect(onPressIn).toHaveBeenCalledTimes(1);
    expect(onPressOut).toHaveBeenCalledTimes(1);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });

  it("can be told to shrink less, for wide rows", () => {
    const view = render(<Subject pressedScale={motion.rowPressScale} />);
    fireEvent(screen.getByTestId("subject"), "pressIn");
    view.rerender(<Subject pressedScale={motion.rowPressScale} />);
    expect(drawnStyle("subject").transform).toEqual([{ scale: motion.rowPressScale }]);
  });
});
