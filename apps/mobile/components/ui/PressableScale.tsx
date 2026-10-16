import type { GestureResponderEvent, PressableProps, StyleProp, ViewStyle } from "react-native";
import { Pressable, StyleSheet } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { motion } from "@/lib/theme-v2";
import { useReduceMotion } from "@/lib/use-reduce-motion";

import { PRESSED_OPACITY } from "./pressable-state";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressableScaleProps extends Omit<PressableProps, "style"> {
  /** A fixed style. The press itself is drawn by the scale, so there is no pressed style to pass. */
  style?: StyleProp<ViewStyle>;
  /** How small it gets while held: the app's press scale unless the control is as wide as a row. */
  pressedScale?: number;
}

/**
 * The app's pressable: it gives a little under the finger and springs back on
 * release, on the UI thread. With Reduce Motion on it dims instead of moving.
 */
export function PressableScale({
  style,
  pressedScale = motion.pressScale,
  onPressIn,
  onPressOut,
  ...props
}: PressableScaleProps) {
  const reduceMotion = useReduceMotion();
  // 0 at rest, 1 while held.
  const held = useSharedValue(0);
  // The dimming goes on top of the caller's own opacity (a disabled button's), not in its place.
  const ownOpacity = StyleSheet.flatten(style)?.opacity;
  const restOpacity = typeof ownOpacity === "number" ? ownOpacity : 1;

  const animatedStyle = useAnimatedStyle(() => {
    const progress = held.get();
    return reduceMotion
      ? { opacity: restOpacity * (1 - progress * (1 - PRESSED_OPACITY)) }
      : { transform: [{ scale: 1 - progress * (1 - pressedScale) }] };
  });

  const settle = (target: 0 | 1) => {
    held.set(reduceMotion
      ? withTiming(target, { duration: motion.duration.fast })
      : withSpring(target, motion.spring.snappy));
  };

  return (
    <AnimatedPressable
      {...props}
      onPressIn={(event: GestureResponderEvent) => {
        settle(1);
        onPressIn?.(event);
      }}
      onPressOut={(event: GestureResponderEvent) => {
        settle(0);
        onPressOut?.(event);
      }}
      style={[style, animatedStyle]}
    />
  );
}
