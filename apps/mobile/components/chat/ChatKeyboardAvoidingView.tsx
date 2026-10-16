import { Platform, View, type ViewProps } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

export interface ChatKeyboardAvoidingViewProps extends ViewProps {
  /** Added to the keyboard's height, as React Native's own view takes it. */
  keyboardVerticalOffset?: number;
}

/**
 * A chat screen's frame. On iOS its bottom edge rises with the keyboard frame
 * by frame, on the UI thread, so the composer travels with the keyboard
 * instead of jumping ahead of it. Android shrinks the window for the keyboard,
 * so there it is a plain view.
 */
export function ChatKeyboardAvoidingView({ keyboardVerticalOffset, ...props }: ChatKeyboardAvoidingViewProps) {
  if (Platform.OS !== "ios") return <View {...props} />;
  return <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={keyboardVerticalOffset} {...props} />;
}
