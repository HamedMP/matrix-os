import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { Pressable } from "react-native";

import { ChatHandoffProvider, useShowChatAfterClosing } from "../components/agents/chat-handoff";

const mockShowChatScreen = jest.fn();
// What is listening to the tabs, by event.
let mockTabsListeners: { type: string; listener: () => void }[] = [];

jest.mock("expo-router", () => ({
  useNavigation: () => ({
    addListener: (type: string, listener: () => void) => {
      const entry = { type, listener };
      mockTabsListeners = [...mockTabsListeners, entry];
      return () => {
        mockTabsListeners = mockTabsListeners.filter((existing) => existing !== entry);
      };
    },
  }),
}));
jest.mock("@/lib/use-shell-navigation", () => ({ useShowChatScreen: () => mockShowChatScreen }));

/** The tabs have taken in a change to their state, such as a screen of the tab having closed. */
function tabsStateChanged() {
  act(() => {
    for (const { type, listener } of mockTabsListeners) if (type === "state") listener();
  });
}

/** A screen of the tab: one control asks for the chat, the other asks and takes it back. */
function Screen() {
  const showChatAfterClosing = useShowChatAfterClosing();
  return (
    <>
      <Pressable testID="ask" onPress={() => showChatAfterClosing?.()} />
      <Pressable testID="ask-and-take-back" onPress={() => showChatAfterClosing?.()()} />
    </>
  );
}

function renderInsideTab() {
  return render(
    <ChatHandoffProvider>
      <Screen />
    </ChatHandoffProvider>,
  );
}

function ask() {
  fireEvent.press(screen.getByTestId("ask"));
}

describe("showing the chat after a screen of the Agents tab has closed", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTabsListeners = [];
  });

  afterEach(cleanup);

  it("listens to the tabs for as long as the tab's layout is drawn, and not after", () => {
    const { unmount } = renderInsideTab();
    expect(mockTabsListeners.map((entry) => entry.type)).toEqual(["state"]);

    unmount();

    expect(mockTabsListeners).toEqual([]);
  });

  it("shows nothing when the tabs change without having been asked", () => {
    renderInsideTab();

    tabsStateChanged();

    expect(mockShowChatScreen).not.toHaveBeenCalled();
  });

  it("does not show the chat in the step it is asked in: the tabs would drop the switch", () => {
    renderInsideTab();

    ask();

    expect(mockShowChatScreen).not.toHaveBeenCalled();
  });

  it("shows the chat once the tabs have taken the next change in", () => {
    renderInsideTab();
    ask();

    tabsStateChanged();

    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
  });

  it("shows it once: later changes of the tabs are no longer its business", () => {
    renderInsideTab();
    ask();
    tabsStateChanged();

    tabsStateChanged();
    tabsStateChanged();

    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
  });

  it("can be asked again, as after coming back to the tab", () => {
    renderInsideTab();
    ask();
    tabsStateChanged();

    ask();
    tabsStateChanged();

    expect(mockShowChatScreen).toHaveBeenCalledTimes(2);
  });

  it("shows nothing once the request is taken back, as when the screen did not close after all", () => {
    renderInsideTab();

    fireEvent.press(screen.getByTestId("ask-and-take-back"));
    tabsStateChanged();

    expect(mockShowChatScreen).not.toHaveBeenCalled();
  });

  it("still shows the chat when the screen that asked is gone by the time the tabs change", () => {
    const { rerender } = renderInsideTab();

    // The screen closes in the same step as it asks.
    ask();
    rerender(<ChatHandoffProvider>{null}</ChatHandoffProvider>);
    tabsStateChanged();

    expect(mockShowChatScreen).toHaveBeenCalledTimes(1);
  });

  it("offers nothing outside the Agents tab, where nothing would hear the tabs change", () => {
    const { result } = renderHook(() => useShowChatAfterClosing());

    expect(result.current).toBeNull();
  });
});
