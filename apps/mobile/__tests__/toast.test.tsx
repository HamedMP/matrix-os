import { act, cleanup, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet } from "react-native";
import type { ReactTestRendererJSON } from "react-test-renderer";

import { Icon } from "../components/ui/Icon";
import { AlertIcon, CheckIcon } from "../components/ui/icons";
import { ToastHost } from "../components/ui/Toast";
import { TOAST_DURATION_MS, dismissToast, showToast } from "../lib/toast";

const SHOWN_FOR = TOAST_DURATION_MS;

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  // Ends the toast on screen, so the next test starts without one.
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe("ToastHost", () => {
  it("draws nothing, and takes no taps, until there is a toast", () => {
    render(<ToastHost />);

    expect(screen.queryByTestId("toast")).toBeNull();
    expect(screen.toJSON()).toMatchObject({ props: { pointerEvents: "box-none" } });
  });

  it("shows a toast with a tick, says it aloud, and takes it away by itself", () => {
    const announce = jest.spyOn(AccessibilityInfo, "announceForAccessibility");
    render(<ToastHost />);

    act(() => showToast("Text copied"));

    expect(screen.getByText("Text copied")).toBeTruthy();
    expect(screen.UNSAFE_getByType(Icon).props.icon).toBe(CheckIcon);
    expect(screen.getByTestId("toast").props.accessibilityRole).toBeUndefined();
    expect(announce).toHaveBeenCalledWith("Text copied");

    act(() => jest.advanceTimersByTime(SHOWN_FOR - 1));
    expect(screen.getByText("Text copied")).toBeTruthy();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("marks a failure as an alert, with its own icon", () => {
    render(<ToastHost />);

    act(() => showToast("Could not copy text. Try again.", "error"));

    expect(screen.getByTestId("toast").props.accessibilityRole).toBe("alert");
    expect(screen.UNSAFE_getByType(Icon).props.icon).toBe(AlertIcon);
  });

  it("lets a later toast take the place of an earlier one, for its whole time", () => {
    render(<ToastHost />);

    act(() => showToast("Text copied"));
    act(() => jest.advanceTimersByTime(SHOWN_FOR - 100));
    act(() => showToast("Chat ID copied"));

    expect(screen.queryByText("Text copied")).toBeNull();
    // The first toast's timers end with it and do not hide the second early.
    act(() => jest.advanceTimersByTime(200));
    expect(screen.getByText("Chat ID copied")).toBeTruthy();
    act(() => jest.advanceTimersByTime(SHOWN_FOR - 200));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("drops the toast, and its timer, when its host goes", () => {
    const view = render(<ToastHost />);
    act(() => showToast("Text copied"));
    expect(jest.getTimerCount()).toBeGreaterThan(0);

    view.unmount();

    expect(jest.getTimerCount()).toBe(0);
    render(<ToastHost />);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("shows nothing when no host is mounted", () => {
    act(() => showToast("Text copied"));
    expect(jest.getTimerCount()).toBe(0);

    render(<ToastHost />);
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("keeps a toast whose dismissal names an earlier one", () => {
    render(<ToastHost />);

    act(() => showToast("Text copied"));
    act(() => dismissToast(-1));

    expect(screen.getByText("Text copied")).toBeTruthy();
  });

  it("sits under the status bar, across the width of the screen", () => {
    render(<ToastHost />);

    act(() => showToast("Text copied"));

    const host = screen.toJSON() as ReactTestRendererJSON;
    expect(StyleSheet.flatten(host.props.style)).toMatchObject({
      position: "absolute",
      left: 0,
      right: 0,
      alignItems: "center",
    });
    expect(StyleSheet.flatten(screen.getByTestId("toast").props.style)).toMatchObject({
      flexDirection: "row",
      borderRadius: 9999,
      backgroundColor: "#171717",
    });
  });
});
