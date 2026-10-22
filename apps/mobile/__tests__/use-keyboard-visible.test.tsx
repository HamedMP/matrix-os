import { act, renderHook } from "@testing-library/react-native";
import { Keyboard } from "react-native";

import { useKeyboardVisible } from "../lib/use-keyboard-visible";

describe("useKeyboardVisible", () => {
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
      return { remove: () => { removed.push(event); } };
    }) as never);
  });

  afterEach(() => jest.restoreAllMocks());

  function emit(event: "keyboardDidShow" | "keyboardDidHide") {
    visible = event === "keyboardDidShow";
    act(() => { for (const listener of listeners[event] ?? []) listener(); });
  }

  it("starts from whether the keyboard is already showing", () => {
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(false);

    visible = true;
    expect(renderHook(() => useKeyboardVisible()).result.current).toBe(true);
  });

  it("follows the keyboard as it shows and hides", () => {
    const { result } = renderHook(() => useKeyboardVisible());

    emit("keyboardDidShow");
    expect(result.current).toBe(true);

    emit("keyboardDidHide");
    expect(result.current).toBe(false);
  });

  it("stops listening when it unmounts", () => {
    const { unmount } = renderHook(() => useKeyboardVisible());
    expect(Object.keys(listeners).sort()).toEqual(["keyboardDidHide", "keyboardDidShow"]);

    unmount();

    expect(removed.sort()).toEqual(["keyboardDidHide", "keyboardDidShow"]);
  });
});
