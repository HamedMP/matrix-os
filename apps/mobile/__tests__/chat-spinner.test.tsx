import { act, cleanup, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Animated, Text } from "react-native";

import { Spinner } from "../components/chat/Spinner";
import { useReduceMotion } from "../components/chat/use-reduce-motion";
import { Icon } from "../components/ui/Icon";
import { LoadingIcon } from "../components/ui/icons";

function Probe() {
  return <Text>{useReduceMotion() ? "still" : "moving"}</Text>;
}

describe("Spinner", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("draws the loading icon at the size and colour it is given", () => {
    render(<Spinner size={14} color="#635F5F" />);

    expect(screen.UNSAFE_getByType(Icon).props).toMatchObject({ icon: LoadingIcon, size: 14, color: "#635F5F" });
  });

  it("turns without holding up work that waits for interactions to finish", () => {
    const timing = jest.spyOn(Animated, "timing");
    const loop = jest.spyOn(Animated, "loop");
    render(<Spinner size={14} color="#635F5F" />);

    expect(loop).toHaveBeenCalledTimes(1);
    expect(timing.mock.calls[0]?.[1]).toMatchObject({ toValue: 1, isInteraction: false, useNativeDriver: true });
  });

  it("names itself for screen readers only when it is given a label", () => {
    render(<Spinner size={14} color="#635F5F" accessibilityLabel="Checking model availability" />);
    expect(screen.getByLabelText("Checking model availability")).toBeTruthy();
    cleanup();

    render(<Spinner size={14} color="#635F5F" testID="quiet" />);
    expect(screen.getByTestId("quiet").props.accessibilityElementsHidden).toBe(true);
  });

  it("stays still when the person has asked for reduced motion", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const stop = jest.fn();
    const start = jest.fn();
    jest.spyOn(Animated, "loop").mockReturnValue({ start, stop, reset: jest.fn() });
    render(<><Spinner size={14} color="#635F5F" /><Probe /></>);

    await screen.findByText("still");

    // The turn it began before the setting was known is the only one, and it was stopped.
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });
});

describe("useReduceMotion", () => {
  afterEach(() => {
    cleanup();
    jest.restoreAllMocks();
  });

  it("reports motion until the setting says otherwise", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    render(<Probe />);

    expect(screen.getByText("moving")).toBeTruthy();
    await act(async () => {});
    expect(screen.getByText("moving")).toBeTruthy();
  });

  it("follows the setting when it changes while the screen is open", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const remove = jest.fn();
    // React Native's jest preset already makes this a mock, shared by every test in the file.
    const listen = jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove } as never);
    listen.mockClear();
    const view = render(<Probe />);
    await act(async () => {});

    const calls = listen.mock.calls as unknown as [string, (enabled: boolean) => void][];
    const onChange = calls.find(([event]) => event === "reduceMotionChanged")![1];
    act(() => onChange(true));
    expect(screen.getByText("still")).toBeTruthy();

    view.unmount();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
