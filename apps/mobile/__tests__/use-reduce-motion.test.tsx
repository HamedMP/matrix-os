import { act, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, Text, View } from "react-native";

import { useReduceMotion } from "../lib/use-reduce-motion";

import { resetReduceMotion } from "./ui-test-utils";

function Probe({ testID }: { testID: string }) {
  return <Text testID={testID}>{useReduceMotion() ? "still" : "moving"}</Text>;
}

function listenCalls(listen: jest.SpyInstance) {
  return (listen.mock.calls as unknown as [string, (enabled: boolean) => void][])
    .filter(([event]) => event === "reduceMotionChanged");
}

describe("useReduceMotion shared setting", () => {
  beforeEach(resetReduceMotion);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("asks the system once however many controls read it", async () => {
    const ask = jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const listen = jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove: jest.fn() } as never);
    render(
      <View>
        <Probe testID="a" />
        <Probe testID="b" />
        <Probe testID="c" />
      </View>,
    );
    await act(async () => {});

    expect(ask).toHaveBeenCalledTimes(1);
    expect(listenCalls(listen)).toHaveLength(1);
    expect(screen.getByTestId("a").props.children).toBe("still");
    expect(screen.getByTestId("c").props.children).toBe("still");
  });

  it("tells every reader when the setting changes", async () => {
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(false);
    const listen = jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove: jest.fn() } as never);
    render(
      <View>
        <Probe testID="a" />
        <Probe testID="b" />
      </View>,
    );
    await act(async () => {});

    act(() => listenCalls(listen)[0]![1](true));

    expect(screen.getByTestId("a").props.children).toBe("still");
    expect(screen.getByTestId("b").props.children).toBe("still");
  });

  it("stops listening when the last reader goes, and asks again for the next one", async () => {
    const ask = jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(true);
    const remove = jest.fn();
    jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove } as never);
    const first = render(<Probe testID="a" />);
    await act(async () => {});
    first.unmount();

    expect(remove).toHaveBeenCalledTimes(1);

    ask.mockResolvedValue(false);
    render(<Probe testID="b" />);
    // Nothing is assumed from before: it starts from motion and asks again.
    expect(screen.getByTestId("b").props.children).toBe("moving");
    await act(async () => {});
    expect(ask).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("b").props.children).toBe("moving");
  });

  it("ignores an answer that arrives after every reader has gone", async () => {
    let answer: (enabled: boolean) => void = () => {};
    jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockReturnValueOnce(
      new Promise<boolean>((resolve) => { answer = resolve; }),
    ).mockResolvedValue(false);
    jest.spyOn(AccessibilityInfo, "addEventListener").mockReturnValue({ remove: jest.fn() } as never);
    const first = render(<Probe testID="a" />);
    first.unmount();
    await act(async () => answer(true));

    render(<Probe testID="b" />);
    await act(async () => {});
    expect(screen.getByTestId("b").props.children).toBe("moving");
  });
});
