import { screen } from "@testing-library/react-native";
import { AccessibilityInfo, StyleSheet } from "react-native";

import { PressableScale } from "../components/ui/PressableScale";
import { motion } from "../lib/theme-v2";

type Style = Record<string, unknown>;

/** The resolved style of a rendered element. */
export function flat(node: { props: { style?: unknown } }): Style {
  return (StyleSheet.flatten(node.props.style as never) ?? {}) as Style;
}

/**
 * The style the pressable carrying `props` takes while it is held down. A
 * Pressable resolves its style function itself, so the rendered view only ever
 * shows the released style.
 */
export function pressedStyle(props: Record<string, unknown>): Style {
  const pressable = screen
    .UNSAFE_getAllByProps(props)
    .find((node) => typeof node.props.style === "function");
  if (!pressable) throw new Error("No pressable with a style function matches these props");
  return (StyleSheet.flatten(pressable.props.style({ pressed: true })) ?? {}) as Style;
}

/**
 * How small the `PressableScale` carrying `props` gets while it is held. The
 * scale runs on the UI thread, so the rendered view only shows it at rest.
 */
export function heldScale(props: Record<string, unknown>): number {
  const pressable = screen
    .UNSAFE_getAllByProps(props)
    .find((node) => node.type === PressableScale);
  if (!pressable) throw new Error("No PressableScale matches these props");
  return (pressable.props.pressedScale as number | undefined) ?? motion.pressScale;
}

/**
 * Puts the system's reduced-motion answer back to "motion", with no calls
 * recorded. React Native's jest preset makes it a mock that a spy reuses, so
 * an answer set by one test would otherwise reach the next.
 */
export function resetReduceMotion(): void {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockReset().mockImplementation(() => Promise.resolve(false));
  jest.mocked(AccessibilityInfo.addEventListener).mockClear();
}
