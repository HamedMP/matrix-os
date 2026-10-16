import { act, renderHook } from "@testing-library/react-native";
import { Keyboard, Platform } from "react-native";

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
    jest.spyOn(Keyboard, "isVisible").mockImplementation(() => visible);
    jest.spyOn(Keyboard, "addListener").mockImplementation(((event: string, listener: () => void) => {
      (listeners[event] ??= []).push(listener);
      return {
        remove: () => {
          removed.push(event);
          listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== listener);
        },
      };
    }) as never);
  });

  afterEach(() => {
    Platform.OS = platform;
    jest.restoreAllMocks();
  });

  // React Native itself only learns the keyboard is up once it has landed.
  function emit(event: KeyboardEvent) {
    if (event === "keyboardDidShow") visible = true;
    if (event === "keyboardDidHide") visible = false;
    act(() => { for (const listener of listeners[event] ?? []) listener(); });
  }

  it("starts from whether the keyboard is already showing", () => {
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(false);

    visible = true;
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(true);
  });

  describe("on iOS", () => {
    beforeEach(() => {
      Platform.OS = "ios";
    });

    it("changes as the keyboard starts to move, so what depends on it moves with the keyboard", () => {
      const { result } = renderHook(() => useKeyboardVisible());

      emit("keyboardWillShow");
      expect(result.current).toBe(true);

      emit("keyboardWillHide");
      expect(result.current).toBe(false);
    });

    it("stops listening when it unmounts", () => {
      const { unmount } = renderHook(() => useKeyboardVisible());
      expect(Object.keys(listeners).sort()).toEqual(["keyboardWillHide", "keyboardWillShow"]);

      unmount();

      expect(removed.sort()).toEqual(["keyboardWillHide", "keyboardWillShow"]);
    });

    it("asks React Native again once nothing has been listening, rather than trust an old event", () => {
      const first = renderHook(() => useKeyboardVisible());
      emit("keyboardWillShow");
      first.unmount();

      // The keyboard closed while no screen was listening.
      visible = false;
      expect(renderHook(() => useKeyboardVisible()).result.current).toBe(false);
    });
  });

  describe("on Android", () => {
    beforeEach(() => {
      Platform.OS = "android";
    });

    // It sends no will-events: the keyboard is known once it has shown.
    it("follows the keyboard as it shows and hides", () => {
      const { result } = renderHook(() => useKeyboardVisible());
      expect(Object.keys(listeners).sort()).toEqual(["keyboardDidHide", "keyboardDidShow"]);

      emit("keyboardDidShow");
      expect(result.current).toBe(true);

      emit("keyboardDidHide");
      expect(result.current).toBe(false);
    });
  });
});
