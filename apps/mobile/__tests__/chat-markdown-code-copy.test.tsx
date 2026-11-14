import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";

import { ToastHost } from "../components/ui/Toast";
import { renderChatMarkdown, type ChatMarkdownTheme } from "../lib/chat-markdown";

const theme: ChatMarkdownTheme = {
  textStyle: { fontSize: 15, color: "#000" },
  mutedColor: "#666",
  linkColor: "#00f",
  codeBackground: "#eee",
  codeBorderColor: "#ccc",
  monoFontFamily: "mono",
  boldFontFamily: "bold",
  headingFontFamily: "heading",
};

function renderReply(text: string) {
  return render(
    <>
      <View>{renderChatMarkdown(text, theme)}</View>
      <ToastHost />
    </>,
  );
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  act(() => jest.runOnlyPendingTimers());
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

describe("fenced code blocks", () => {
  it("name their language and copy exactly the code, without the fences", async () => {
    renderReply("Run this:\n```bash\necho hi\npwd\n```\nDone.");

    expect(screen.getByText("bash")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("Copy code"));

    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("echo hi\npwd");
    expect(Haptics.notificationAsync).toHaveBeenCalledWith(Haptics.NotificationFeedbackType.Success);
  });

  it("call a block without a language text", () => {
    renderReply("```\nplain\n```");

    expect(screen.getByText("text")).toBeTruthy();
    expect(screen.getByLabelText("Copy code")).toBeTruthy();
  });

  it("go back to Copy after a moment", async () => {
    renderReply("```ts\nconst a = 1;\n```");

    fireEvent.press(screen.getByLabelText("Copy code"));
    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    act(() => jest.advanceTimersByTime(2000));

    expect(screen.queryByText("Copied")).toBeNull();
    expect(screen.getByText("Copy")).toBeTruthy();
  });

  it("say in their own words when the clipboard fails", async () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Clipboard, "setStringAsync").mockRejectedValueOnce(new Error("secret native failure"));
    renderReply("```ts\nconst a = 1;\n```");

    fireEvent.press(screen.getByLabelText("Copy code"));

    await waitFor(() => expect(screen.getByText("Could not copy code. Try again.")).toBeTruthy());
    expect(screen.queryByText("Copied")).toBeNull();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret native failure");
  });

  it("treat a clipboard that refuses the code as a failure", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Clipboard, "setStringAsync").mockResolvedValueOnce(false);
    renderReply("```ts\nconst a = 1;\n```");

    fireEvent.press(screen.getByLabelText("Copy code"));

    await waitFor(() => expect(screen.getByText("Could not copy code. Try again.")).toBeTruthy());
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("copy what has arrived of a block that is still streaming", async () => {
    renderReply("```bash\necho one");

    fireEvent.press(screen.getByLabelText("Copy code"));

    await waitFor(() => expect(screen.getByText("Copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("echo one");
  });
});

describe("inline code", () => {
  it("copies the span's own text on a tap", async () => {
    renderReply("Run `pnpm install` first.");

    fireEvent.press(screen.getByText("pnpm install"));

    await waitFor(() => expect(screen.getByText("Code copied")).toBeTruthy());
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith("pnpm install");
  });

  it("says so when the clipboard fails", async () => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
    jest.spyOn(Clipboard, "setStringAsync").mockRejectedValueOnce(new Error("nope"));
    renderReply("Run `pnpm install` first.");

    fireEvent.press(screen.getByText("pnpm install"));

    await waitFor(() => expect(screen.getByText("Could not copy code. Try again.")).toBeTruthy());
  });

  it("leaves the rest of the paragraph alone", () => {
    renderReply("Run `pnpm install` first.");

    expect(screen.getByText("Run ").props.onPress).toBeUndefined();
    expect(screen.getByText("pnpm install").props.onLongPress).toBeUndefined();
  });
});
