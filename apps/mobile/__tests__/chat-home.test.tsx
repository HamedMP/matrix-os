import { cleanup, fireEvent, render, screen } from "@testing-library/react-native";
import { Image } from "expo-image";
import { StyleSheet as NativeStyleSheet } from "react-native";

import { ChatHome } from "../components/chat/ChatHome";
import { CHAT_SUGGESTIONS } from "../components/chat/chat-suggestions";

import { flat, pressedStyle } from "./ui-test-utils";

describe("ChatHome", () => {
  afterEach(cleanup);

  it("offers the three starters the design names, in order", () => {
    expect(CHAT_SUGGESTIONS).toEqual([
      "Build an app that tracks my habits",
      "Summarize today's emails",
      "Plan my week around meetings",
    ]);
  });

  it("greets with the Matrix mark, the heading and one button per suggestion", () => {
    render(<ChatHome suggestions={CHAT_SUGGESTIONS} onSuggestionPress={jest.fn()} />);

    expect(screen.getByRole("header", { name: "What should we work on?" })).toBeTruthy();
    const mark = NativeStyleSheet.flatten(screen.UNSAFE_getByType(Image).props.style) as Record<string, number>;
    expect(mark.height).toBe(40);
    for (const suggestion of CHAT_SUGGESTIONS) {
      expect(screen.getByRole("button", { name: suggestion })).toBeTruthy();
    }
    expect(screen.queryByText(/Welcome back/)).toBeNull();
  });

  it("centres the block in the space it is given, 16pt between its parts", () => {
    render(<ChatHome suggestions={CHAT_SUGGESTIONS} onSuggestionPress={jest.fn()} />);

    const scroll = screen.getByTestId("chat-home");
    expect(flat(scroll)).toMatchObject({ flex: 1 });
    expect(NativeStyleSheet.flatten(scroll.props.contentContainerStyle)).toMatchObject({
      flexGrow: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      gap: 16,
    });
    expect(flat(screen.getByTestId("chat-home-suggestions"))).toMatchObject({ paddingTop: 12, gap: 8 });
  });

  it("draws the heading and the suggestion rows from tokens", () => {
    render(<ChatHome suggestions={CHAT_SUGGESTIONS} onSuggestionPress={jest.fn()} />);

    expect(flat(screen.getByRole("header", { name: "What should we work on?" }))).toMatchObject({
      fontFamily: "Geist_600SemiBold",
      fontSize: 24,
      lineHeight: 34,
      color: "#242323",
      textAlign: "center",
    });
    const row = screen.getByRole("button", { name: CHAT_SUGGESTIONS[0] });
    expect(flat(row)).toMatchObject({
      backgroundColor: "#FAF9F7",
      borderRadius: 14,
      paddingHorizontal: 16,
      paddingVertical: 14,
      minHeight: 44,
    });
    expect(flat(screen.getByText(CHAT_SUGGESTIONS[0]))).toMatchObject({
      fontFamily: "Geist_400Regular",
      fontSize: 14,
      lineHeight: 20,
      color: "#242323",
    });
    expect(pressedStyle({ accessibilityLabel: CHAT_SUGGESTIONS[0] }).opacity).toBe(0.65);
  });

  it("hands the tapped suggestion's text to its handler", () => {
    const onSuggestionPress = jest.fn();
    render(<ChatHome suggestions={CHAT_SUGGESTIONS} onSuggestionPress={onSuggestionPress} />);

    fireEvent.press(screen.getByRole("button", { name: "Summarize today's emails" }));

    expect(onSuggestionPress).toHaveBeenCalledTimes(1);
    expect(onSuggestionPress).toHaveBeenCalledWith("Summarize today's emails");
  });

  it("lets a suggestion take a tap while the keyboard is open, and closes the keyboard on a tap elsewhere", () => {
    render(<ChatHome suggestions={CHAT_SUGGESTIONS} onSuggestionPress={jest.fn()} />);

    expect(screen.getByTestId("chat-home").props.keyboardShouldPersistTaps).toBe("handled");
  });
});
