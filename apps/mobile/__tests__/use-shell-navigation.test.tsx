const mockDispatch = jest.fn();
const mockTabNavigate = jest.fn();
const mockNavigate = jest.fn();
const mockDismissTo = jest.fn();
const mockNavigation = { dispatch: mockDispatch, navigate: mockTabNavigate };
const mockRouter = { navigate: mockNavigate, dismissTo: mockDismissTo };

jest.mock("expo-router", () => ({ useNavigation: () => mockNavigation, useRouter: () => mockRouter }));

import { renderHook } from "@testing-library/react-native";

import { useOpenSidePanel, useShowChatScreen, useShowTab } from "../lib/use-shell-navigation";

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
  it("switches to the Chats tab, then closes what is open above the chat screen", () => {
    const { result } = renderHook(() => useShowChatScreen());

    result.current();

    // A tab switch by name keeps the Chats tab's own stack; navigating to the
    // chat screen's href would push a second chat screen instead.
    expect(mockTabNavigate).toHaveBeenCalledWith("(chats)");
    expect(mockDismissTo).toHaveBeenCalledWith("/(drawer)");
    expect(mockTabNavigate.mock.invocationCallOrder[0]).toBeLessThan(mockDismissTo.mock.invocationCallOrder[0]);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("keeps the same function between renders", () => {
    const { result, rerender } = renderHook(() => useShowChatScreen());
    const first = result.current;

    rerender({});

    expect(result.current).toBe(first);
  });
});

describe("useShowTab", () => {
  it.each(["terminal", "settings"] as const)("switches to the %s tab", (tab) => {
    const { result } = renderHook(() => useShowTab());

    result.current(tab);

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith(`/${tab}`);
  });

  it("keeps the same function between renders", () => {
    const { result, rerender } = renderHook(() => useShowTab());
    const first = result.current;

    rerender({});

    expect(result.current).toBe(first);
  });
});
