import { act, renderHook } from "@testing-library/react-native";
import { Keyboard, Platform } from "react-native";
import { KeyboardController, KeyboardEvents } from "react-native-keyboard-controller";

import { useKeyboardVisible } from "../lib/use-keyboard-visible";

type KeyboardEvent = "keyboardWillShow" | "keyboardWillHide" | "keyboardDidShow" | "keyboardDidHide";

describe("useKeyboardVisible", () => {
  const platform = Platform.OS;
  let visible = false;
  let listeners: Record<string, (() => void)[]> = {};
  const removed: string[] = [];

  beforeEach(() => {
    visible = false;
    listeners = {};
    removed.length = 0;
    jest.spyOn(KeyboardController, "isVisible").mockImplementation(() => visible);
    jest.spyOn(KeyboardEvents, "addListener").mockImplementation(((event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
      return {
        remove: () => {
          removed.push(event);
          listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== listener);
        },
      };
    }) as never);
    jest.spyOn(Keyboard, "addListener");
  });

  afterEach(() => {
    Platform.OS = platform;
    jest.restoreAllMocks();
  });

  // The controller counts the keyboard as up from the moment it starts to show
  // until it has gone.
  function emit(event: KeyboardEvent) {
    if (event === "keyboardWillShow") visible = true;
    if (event === "keyboardDidHide") visible = false;
    act(() => { for (const listener of listeners[event] ?? []) listener(); });
  }

  it("starts from whether the keyboard is already showing", () => {
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(false);

    visible = true;
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(true);
  });

  // Android used to say only once the keyboard had landed, a moment after it
  // appeared; the controller says when it starts to move there too.
  describe.each(["ios", "android"] as const)("on %s", (os) => {
    beforeEach(() => {
      Platform.OS = os;
    });

    it("changes as the keyboard starts to move, so what depends on it moves with the keyboard", () => {
      const { result } = renderHook(() => useKeyboardVisible());

      emit("keyboardWillShow");
      expect(result.current).toBe(true);

      emit("keyboardWillHide");
      expect(result.current).toBe(false);
    });

    it("listens to the keyboard controller only, not React Native's later events", () => {
      renderHook(() => useKeyboardVisible());

      expect(Object.keys(listeners).sort()).toEqual(["keyboardWillHide", "keyboardWillShow"]);
      expect(Keyboard.addListener).not.toHaveBeenCalled();
    });
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = renderHook(() => useKeyboardVisible());

    unmount();

    expect(removed.sort()).toEqual(["keyboardWillHide", "keyboardWillShow"]);
  });

  it("asks the controller again once nothing has been listening, rather than trust an old event", () => {
    const first = renderHook(() => useKeyboardVisible());
    emit("keyboardWillShow");
    first.unmount();

    // The keyboard closed while no screen was listening.
    visible = false;
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(false);
  });
});
