import { screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";

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
