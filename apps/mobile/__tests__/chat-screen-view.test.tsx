import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { KeyboardAvoidingView, Text } from "react-native";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";

import { ChatScreenView, type ChatScreenViewProps } from "../components/chat/ChatScreenView";
import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";
import { Icon } from "../components/ui/Icon";
import { NewChatIcon, SidePanelIcon } from "../components/ui/icons";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

import { flat } from "./ui-test-utils";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

let mockKeyboardVisible = false;
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => mockKeyboardVisible }));

const sent: TranscriptMessage = {
  id: "msg_user", role: "user", text: "Build an app that tracks my habits",
  toolCalls: [], activities: [], isRunning: false, createdAt: 0,
};

function props(overrides: Partial<ChatScreenViewProps> = {}): ChatScreenViewProps {
  return {
    title: "New chat",
    onOpenSidePanel: jest.fn(),
    showHome: true,
    suggestions: CHAT_SUGGESTIONS,
    onSuggestionPress: jest.fn(),
    messages: [],
    composer: { draft: "", onChangeDraft: jest.fn(), placeholder: "Ask anything", canSend: false, onSend: jest.fn() },
    ...overrides,
  };
}

describe("ChatScreenView", () => {
  afterEach(() => {
    cleanup();
    mockKeyboardVisible = false;
  });

  it("draws a new chat from its props alone: top bar, greeting, suggestions and composer", () => {
    render(<ChatScreenView {...props()} />);

    expect(screen.getByRole("header", { name: "New chat" })).toBeTruthy();
    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.getByRole("button", { name: CHAT_SUGGESTIONS[0] })).toBeTruthy();
    expect(screen.getByPlaceholderText("Ask anything")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();
  });

  it("draws a chat's messages in place of the greeting", () => {
    render(<ChatScreenView {...props({ title: "Habit tracker app", showHome: false, messages: [sent], chatId: "chat_1" })} />);

    expect(screen.getByRole("header", { name: "Habit tracker app" })).toBeTruthy();
    expect(screen.getByText("Build an app that tracks my habits")).toBeTruthy();
    expect(screen.queryByText("What should we work on?")).toBeNull();
  });

  it("opens the side panel from the button on the left of the top bar", () => {
    const onOpenSidePanel = jest.fn();
    render(<ChatScreenView {...props({ onOpenSidePanel })} />);

    const button = screen.getByRole("button", { name: "Open chats and projects" });
    expect(flat(button)).toMatchObject({ width: 44, height: 44 });
    expect(button.findByType(Icon).props.icon).toBe(SidePanelIcon);

    fireEvent.press(button);

    expect(onOpenSidePanel).toHaveBeenCalledTimes(1);
  });

  it("offers New chat on the right only while a chat is open", () => {
    const onNewChat = jest.fn();
    const view = render(<ChatScreenView {...props()} />);
    expect(screen.queryByRole("button", { name: "New chat" })).toBeNull();

    view.rerender(<ChatScreenView {...props({ title: "Habit tracker app", showHome: false, messages: [sent], onNewChat })} />);
    const button = screen.getByRole("button", { name: "New chat" });
    expect(flat(button)).toMatchObject({ width: 44, height: 44 });
    expect(button.findByType(Icon).props.icon).toBe(NewChatIcon);

    fireEvent.press(button);

    expect(onNewChat).toHaveBeenCalledTimes(1);
  });

  it("hands a tapped suggestion to the screen", () => {
    const onSuggestionPress = jest.fn();
    render(<ChatScreenView {...props({ onSuggestionPress })} />);

    fireEvent.press(screen.getByRole("button", { name: "Plan my week around meetings" }));

    expect(onSuggestionPress).toHaveBeenCalledWith("Plan my week around meetings");
  });

  it("starts below the status bar on the background colour and measures the keyboard from the top of the window", () => {
    render(
      <SafeAreaInsetsContext.Provider value={{ top: 62, right: 0, bottom: 34, left: 0 }}>
        <ChatScreenView {...props()} />
      </SafeAreaInsetsContext.Provider>,
    );

    const keyboardView = screen.UNSAFE_getByType(KeyboardAvoidingView);
    expect(flat(keyboardView)).toMatchObject({ flex: 1, paddingTop: 62, backgroundColor: "#FFFEFC" });
    expect(keyboardView.props.behavior).toBe("padding");
    // The tab bar is below this view, not inside it, so there is nothing to
    // offset the keyboard by, and the tab bar owns the bottom inset.
    expect(keyboardView.props.keyboardVerticalOffset).toBeUndefined();
    expect(flat(keyboardView).paddingBottom).toBeUndefined();
    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(10);
  });

  it("rests the composer 8pt above the keyboard while it is open", () => {
    mockKeyboardVisible = true;
    render(<ChatScreenView {...props()} />);

    expect(flat(screen.getByTestId("composer")).paddingBottom).toBe(8);
  });

  it("passes the model control and the composer's state through", () => {
    const onStop = jest.fn();
    render(
      <ChatScreenView
        {...props({
          showHome: false,
          messages: [sent],
          composer: {
            draft: "", onChangeDraft: jest.fn(), placeholder: "Reply…", canSend: false, onSend: jest.fn(),
            running: true, onStop, modelControl: <Text>Matrix AI · Sonnet 5</Text>,
          },
        })}
      />,
    );

    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy();
    expect(screen.getByText("Matrix AI · Sonnet 5")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Stop" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });
});
