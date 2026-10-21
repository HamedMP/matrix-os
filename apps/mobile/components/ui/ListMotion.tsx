import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";

import { motion } from "@/lib/theme-v2";

import { listItemExit, listItemLayout } from "./list-motion-animations";

/**
 * Content that arrives in place of its loading placeholders: it fades in
 * once, as a whole.
 */
export function SettleIn({
  children,
  style,
  testID,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <Animated.View entering={FadeIn.duration(motion.duration.base)} style={style} testID={testID}>
      {children}
    </Animated.View>
  );
}

/**
 * A row of a list that can change once it is on screen: a row removed fades
 * out, and the rows after it move up into its place.
 */
export function ListItemMotion({ children, testID }: { children: ReactNode; testID?: string }) {
  return (
    <Animated.View testID={testID} exiting={listItemExit} layout={listItemLayout}>
      {children}
    </Animated.View>
  );
}
