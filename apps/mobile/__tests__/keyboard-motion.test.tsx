import { render, screen } from "@testing-library/react-native";
import { Platform, Text } from "react-native";
import { KeyboardAvoidingView, KeyboardProvider } from "react-native-keyboard-controller";

import { ChatKeyboardAvoidingView } from "../components/chat/ChatKeyboardAvoidingView";
import { KeyboardMotionProvider } from "../components/KeyboardMotionProvider";

describe("keyboard motion", () => {
  const platform = Platform.OS;

  afterEach(() => {
    Platform.OS = platform;
  });

  describe("on iOS", () => {
    beforeEach(() => {
      Platform.OS = "ios";
    });

    it("lets screens follow the keyboard frame by frame", () => {
      render(<KeyboardMotionProvider><Text>Chat</Text></KeyboardMotionProvider>);

      expect(screen.UNSAFE_getByType(KeyboardProvider)).toBeTruthy();
      expect(screen.getByText("Chat")).toBeTruthy();
    });

    it("lifts a chat screen's bottom edge with the keyboard as it moves, keeping the screen's own offset", () => {
      render(
        <ChatKeyboardAvoidingView testID="frame" style={{ flex: 1 }} keyboardVerticalOffset={-34}>
          <Text>Composer</Text>
        </ChatKeyboardAvoidingView>,
      );

      const frame = screen.UNSAFE_getByType(KeyboardAvoidingView);
      expect(frame.props).toMatchObject({ behavior: "padding", keyboardVerticalOffset: -34, testID: "frame", style: { flex: 1 } });
      expect(screen.getByText("Composer")).toBeTruthy();
    });
  });

  describe("on Android", () => {
    beforeEach(() => {
      Platform.OS = "android";
    });

    // There the window shrinks for the keyboard; the provider would turn that
    // off for every screen, including the ones that rely on it.
    it("leaves the keyboard to the window", () => {
      render(<KeyboardMotionProvider><Text>Chat</Text></KeyboardMotionProvider>);

      expect(screen.UNSAFE_queryByType(KeyboardProvider)).toBeNull();
      expect(screen.getByText("Chat")).toBeTruthy();
    });

    it("draws a chat screen as a plain view, which the shrinking window makes room for", () => {
      render(
        <ChatKeyboardAvoidingView testID="frame" style={{ flex: 1 }} keyboardVerticalOffset={-34}>
          <Text>Composer</Text>
        </ChatKeyboardAvoidingView>,
      );

      expect(screen.UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();
      expect(screen.getByTestId("frame").props.style).toEqual({ flex: 1 });
      expect(screen.getByText("Composer")).toBeTruthy();
    });
  });
});
