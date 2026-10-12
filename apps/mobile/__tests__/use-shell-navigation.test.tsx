const mockDispatch = jest.fn();
const mockNavigate = jest.fn();
const mockNavigation = { dispatch: mockDispatch, navigate: mockNavigate };

jest.mock("expo-router", () => ({ useNavigation: () => mockNavigation }));

import { renderHook } from "@testing-library/react-native";

import { useOpenSidePanel, useShowChatScreen } from "../lib/use-shell-navigation";

beforeEach(() => jest.clearAllMocks());

describe("useOpenSidePanel", () => {
  it("asks the nearest drawer above the screen to open", () => {
    const { result } = renderHook(() => useOpenSidePanel());

    result.current();

    // The screen sits two navigators below the drawer, so it dispatches the
    // action for the drawer to pick up instead of calling a method on its own
    // navigator, which has none for this.
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledWith({ type: "OPEN_DRAWER" });
  });

  it("keeps the same function between renders", () => {
    const { result, rerender } = renderHook(() => useOpenSidePanel());
    const first = result.current;

    rerender({});

    expect(result.current).toBe(first);
  });
});

describe("useShowChatScreen", () => {
  it("switches to the Chats tab and returns its stack to the chat screen", () => {
    const { result } = renderHook(() => useShowChatScreen());

    result.current();

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith("(tabs)", {
      screen: "(chats)",
      params: { screen: "index", pop: true },
    });
  });

  it("hands React Navigation new params each time, since it ignores ones it has used", () => {
    const { result } = renderHook(() => useShowChatScreen());

    result.current();
    result.current();

    const [first, second] = mockNavigate.mock.calls.map((call) => call[1]);
    expect(first).not.toBe(second);
    expect(first.params).not.toBe(second.params);
  });
});
