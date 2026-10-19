import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { ChatScreenView, type ChatScreenViewProps } from "../components/chat/ChatScreenView";
import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));
jest.mock("@/lib/use-keyboard-visible", () => ({ useKeyboardVisible: () => false }));

const unsent: TranscriptMessage = {
  id: "optimistic-req_2", role: "user", text: "Ship it", toolCalls: [], activities: [], isRunning: false, createdAt: 0,
  delivery: "failed", retryBlocked: false,
};

function props(overrides: Partial<ChatScreenViewProps> = {}): ChatScreenViewProps {
  return {
    title: "Habit tracker app",
    onOpenSidePanel: jest.fn(),
    showHome: false,
    suggestions: CHAT_SUGGESTIONS,
    onSuggestionPress: jest.fn(),
    messages: [],
    chatId: "chat_1",
    composer: { draft: "", onChangeDraft: jest.fn(), placeholder: "Reply…", canSend: false, onSend: jest.fn() },
    ...overrides,
  };
}

describe("the chat screen while a chat opens", () => {
  afterEach(cleanup);

  it("shows the shape of a conversation while the chat's messages load, with the composer in place", () => {
    render(<ChatScreenView {...props({ chatState: "loading" })} />);

    expect(screen.getByLabelText("Loading chat")).toBeTruthy();
    expect(screen.getAllByTestId("chat-loading-row").length).toBeGreaterThan(0);
    expect(screen.getByPlaceholderText("Reply…")).toBeTruthy();
    expect(screen.queryByText("Chat unavailable")).toBeNull();
  });

  it("says the chat could not be opened, and tries again on request", () => {
    const onReloadChat = jest.fn();
    render(<ChatScreenView {...props({ chatState: "failed", onReloadChat })} />);

    expect(screen.getByRole("alert", { name: "Chat unavailable" })).toBeTruthy();
    expect(screen.getByText("Check your connection, then try again.")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    expect(onReloadChat).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Loading chat")).toBeNull();
  });

  it("shows the messages once they are there, with what a message that was not sent offers", () => {
    const unsentActions = { onRetry: jest.fn(), onEdit: jest.fn() };
    render(<ChatScreenView {...props({ chatState: "ready", messages: [unsent], unsentActions })} />);

    expect(screen.getByText("Ship it")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));
    expect(unsentActions.onRetry).toHaveBeenCalledWith("optimistic-req_2");
  });

  it("keeps the greeting for a new chat whatever the state", () => {
    render(<ChatScreenView {...props({ showHome: true, chatId: null, chatState: "loading" })} />);

    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    expect(screen.queryByLabelText("Loading chat")).toBeNull();
  });
});
