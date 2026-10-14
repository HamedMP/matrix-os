import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { Alert, Pressable, Share, Text, type AlertButton } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { ChatContextMenu } from "../components/ChatContextMenu";
import { ToastHost } from "../components/ui/Toast";

// Jest resolves the iOS files; this suite draws the menu Android draws.
jest.mock("../components/ChatMenuTrigger", () => jest.requireActual("../components/ChatMenuTrigger.tsx"));

const REPLY = "Done. It has a daily checklist.";

function row(onPress = jest.fn()) {
  return <Pressable testID="row" onPress={onPress}><Text>Row</Text></Pressable>;
}

function renderMenu(props: { chatId?: string | null; messageText?: string | null }) {
  const onPress = jest.fn();
  const view = render(
    <>
      <ChatContextMenu {...props}>{row(onPress)}</ChatContextMenu>
      <ToastHost />
    </>,
  );
  return { ...view, onPress };
}

/** Opens the menu with a long press and returns the alert's arguments. */
function openMenu(alert: jest.SpyInstance) {
  fireEvent(screen.getByTestId("row"), "longPress");
  const [title, message, buttons, options] = alert.mock.calls.at(-1) as [string, string | undefined, AlertButton[], object];
  return { title, message, buttons, options };
}

function press(buttons: AlertButton[], text: string) {
  const button = buttons.find((candidate) => candidate.text === text);
  expect(button).toBeDefined();
  button!.onPress?.();
}

let alert: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => {
  // Ends the toast on screen, so the next test starts without one.
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("ChatContextMenu on Android", () => {
  it("opens an alert with Copy text, Share and Copy chat ID for a message, and a medium haptic", () => {
    const { onPress } = renderMenu({ chatId: "chat_1", messageText: REPLY });

    const { title, message, buttons, options } = openMenu(alert);

    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
    expect(title).toBe("Message");
    expect(message).toBeUndefined();
    // Android's alert has room for three buttons; a tap outside or Back closes it.
    expect(buttons.map((button) => button.text)).toEqual(["Copy text", "Share", "Copy chat ID"]);
    expect(options).toEqual({ cancelable: true });
    expect(onPress).not.toHaveBeenCalled();
  });

  it("offers Copy chat ID and Cancel for a chat as a whole", () => {
    renderMenu({ chatId: "chat_1" });

    const { title, buttons } = openMenu(alert);

    expect(title).toBe("Chat");
    expect(buttons.map((button) => [button.text, button.style])).toEqual([
      ["Copy chat ID", undefined],
      ["Cancel", "cancel"],
    ]);
  });

  it("opens nothing for a chat that does not exist yet", () => {
    renderMenu({ chatId: null });

    fireEvent(screen.getByTestId("row"), "longPress");

    expect(alert).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).not.toHaveBeenCalled();
  });

  it("copies the text and the chat ID, each with its own toast", async () => {
    renderMenu({ chatId: "chat_native_full_id", messageText: REPLY });

    press(openMenu(alert).buttons, "Copy text");
    await waitFor(() => expect(screen.getByText("Text copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(REPLY);

    press(openMenu(alert).buttons, "Copy chat ID");
    await waitFor(() => expect(screen.getByText("Chat ID copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("chat_native_full_id");
    // A later toast takes the place of the one before.
    expect(screen.queryByText("Text copied")).toBeNull();
  });

  it("shares the message's text through the system share sheet", async () => {
    const share = jest.spyOn(Share, "share").mockResolvedValue({ action: Share.sharedAction });
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    press(openMenu(alert).buttons, "Share");

    await waitFor(() => expect(share).toHaveBeenCalledWith({ message: REPLY }));
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("says in its own words when sharing fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Share, "share").mockRejectedValue(new Error("secret activity failure"));
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    press(openMenu(alert).buttons, "Share");

    await waitFor(() => expect(screen.getByText("Could not share. Try again.")).toBeTruthy());
    expect(JSON.stringify(screen.toJSON())).not.toContain("secret activity failure");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret activity failure");
  });

  it("does nothing from a menu opened for a chat that is no longer shown", async () => {
    const view = renderMenu({ chatId: "chat_old" });
    const { buttons } = openMenu(alert);

    view.rerender(
      <>
        <ChatContextMenu chatId="chat_new">{row()}</ChatContextMenu>
        <ToastHost />
      </>,
    );
    press(buttons, "Copy chat ID");
    await act(async () => {});
    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();

    press(openMenu(alert).buttons, "Copy chat ID");
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_new"));
  });

  it("says nothing about a copy that ends after its chat has left the screen", async () => {
    let finish!: (copied: boolean) => void;
    jest.spyOn(Clipboard, "setStringAsync").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const view = renderMenu({ chatId: "chat_old" });

    press(openMenu(alert).buttons, "Copy chat ID");
    view.rerender(
      <>
        <ChatContextMenu chatId="chat_new">{row()}</ChatContextMenu>
        <ToastHost />
      </>,
    );
    await act(async () => finish(true));

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("chat_old");
    expect(screen.queryByTestId("toast")).toBeNull();
  });

  it("shows only the latest copy's result when an earlier one ends after it", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    let failFirst!: (error: Error) => void;
    jest.spyOn(Clipboard, "setStringAsync")
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce(true);
    renderMenu({ chatId: "chat_1", messageText: REPLY });

    press(openMenu(alert).buttons, "Copy text");
    press(openMenu(alert).buttons, "Copy chat ID");
    await waitFor(() => expect(screen.getByText("Chat ID copied")).toBeTruthy());
    await act(async () => failFirst(new Error("slow failure")));

    expect(screen.getByText("Chat ID copied")).toBeTruthy();
    expect(screen.queryByText("Could not copy text. Try again.")).toBeNull();
  });

  it("does nothing from a menu whose row has gone", async () => {
    const view = renderMenu({ chatId: "chat_1", messageText: REPLY });
    const { buttons } = openMenu(alert);

    view.unmount();
    press(buttons, "Copy text");
    await act(async () => {});

    expect(Clipboard.setStringAsync).not.toHaveBeenCalled();
  });
});
