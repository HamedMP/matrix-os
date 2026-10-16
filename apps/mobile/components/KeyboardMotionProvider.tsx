import type { ReactNode } from "react";
import { Platform } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";

/**
 * Lets screens follow the keyboard frame by frame on iOS. Android is left to
 * shrink the window for the keyboard, as it does now: in an edge-to-edge app
 * the provider stops that for every screen, including the ones built on it.
 */
export function KeyboardMotionProvider({ children }: { children: ReactNode }) {
  if (Platform.OS !== "ios") return children;
  return <KeyboardProvider>{children}</KeyboardProvider>;
}
