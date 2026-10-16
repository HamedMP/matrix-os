import { act, cleanup, fireEvent, render, screen } from "@testing-library/react-native";

import { MessageList } from "../components/chat/MessageList";
import { UnsentMessageActionsProvider } from "../components/chat/unsent-message-actions";
import { UserMessage } from "../components/chat/UserMessage";
import type { TranscriptMessage } from "../lib/canonical-chat-transcript";

jest.mock("micromark", () => ({ micromark: jest.fn() }));
jest.mock("micromark-extension-gfm", () => ({ gfm: jest.fn(), gfmHtml: jest.fn() }));

function sent(overrides: Partial<TranscriptMessage> = {}): TranscriptMessage {
  return {
    id: "optimistic-req_2", role: "user", text: "Ship it", toolCalls: [], activities: [], isRunning: false, createdAt: 0,
    ...overrides,
  };
}

describe("a message sent from this phone", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    act(() => jest.runOnlyPendingTimers());
    cleanup();
    jest.useRealTimers();
  });

  it("says nothing while a send is quick, and says it is sending once it takes a while", () => {
    render(<UserMessage text="Ship it" delivery="sending" />);
    expect(screen.queryByText("Sending…")).toBeNull();

    act(() => jest.advanceTimersByTime(999));
    expect(screen.queryByText("Sending…")).toBeNull();
    act(() => jest.advanceTimersByTime(1));
    expect(screen.getByText("Sending…")).toBeTruthy();
  });

  it("says nothing once the computer has it, or for a message read from the computer", () => {
    render(<UserMessage text="Ship it" />);
    act(() => jest.advanceTimersByTime(5_000));

    expect(screen.queryByText("Sending…")).toBeNull();
    expect(screen.queryByText("Not sent")).toBeNull();
  });

  it("says it was not sent, and offers to send it again or edit it", () => {
    const onRetry = jest.fn();
    const onEdit = jest.fn();
    render(<UserMessage text="Ship it" delivery="failed" onRetry={onRetry} onEdit={onEdit} />);

    expect(screen.getByText("Ship it")).toBeTruthy();
    expect(screen.getByRole("alert", { name: "Not sent" })).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));
    fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("keeps Retry off while the message cannot be sent again, but still lets it be edited", () => {
    const onRetry = jest.fn();
    const onEdit = jest.fn();
    render(<UserMessage text="Ship it" delivery="failed" onRetry={onRetry} onEdit={onEdit} retryDisabled />);

    const retry = screen.getByRole("button", { name: "Retry sending" });
    expect(retry.props.accessibilityState).toMatchObject({ disabled: true });
    fireEvent.press(retry);
    expect(onRetry).not.toHaveBeenCalled();
    fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("is given its actions by the chat it is shown in, by its own id", () => {
    const actions = { onRetry: jest.fn(), onEdit: jest.fn() };
    const unsent = sent({ delivery: "failed", retryBlocked: false });
    render(
      <UnsentMessageActionsProvider value={actions}>
        <MessageList messages={[unsent, sent({ id: "msg_old", text: "Earlier" })]} chatId="chat_1" />
      </UnsentMessageActionsProvider>,
    );

    expect(screen.getAllByText("Not sent")).toHaveLength(1);
    fireEvent.press(screen.getByRole("button", { name: "Retry sending" }));
    fireEvent.press(screen.getByRole("button", { name: "Edit message" }));
    expect(actions.onRetry).toHaveBeenCalledWith("optimistic-req_2");
    expect(actions.onEdit).toHaveBeenCalledWith("optimistic-req_2");
  });

  it("only says it was not sent where the chat offers nothing to do about it", () => {
    render(<MessageList messages={[sent({ delivery: "failed" })]} chatId="chat_1" />);

    expect(screen.getByText("Not sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry sending" })).toBeNull();
  });
});
