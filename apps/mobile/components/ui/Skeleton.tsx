import { useEffect } from "react";
import { View, type StyleProp, type ViewProps, type ViewStyle } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { StyleSheet } from "react-native-unistyles";

import { space, type SpaceStep } from "@/lib/theme-v2";
import { useReduceMotion } from "@/lib/use-reduce-motion";

// One sweep of the lighter band across a placeholder.
const SWEEP_MS = 1_250;
// Where the band starts and ends, past the placeholder's edges on both sides.
const SWEEP_FROM = -120;
const SWEEP_TO = 520;

export interface SkeletonProps extends Omit<ViewProps, "children" | "style"> {
  style?: StyleProp<ViewStyle>;
  shimmerTestID?: string;
}

/**
 * A loading placeholder: a grey block with a lighter band sweeping across it,
 * on the UI thread. With Reduce Motion on it holds still.
 */
export function Skeleton({ style, shimmerTestID, ...props }: SkeletonProps) {
  const reduceMotion = useReduceMotion();
  const sweep = useSharedValue(0);

  useEffect(() => {
    if (reduceMotion) return;
    sweep.set(withRepeat(withTiming(1, { duration: SWEEP_MS, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(sweep);
  }, [reduceMotion, sweep]);

  const shimmerStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: SWEEP_FROM + sweep.get() * (SWEEP_TO - SWEEP_FROM) },
      { rotate: "12deg" },
    ],
  }));

  return (
    <View
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.base, style]}
    >
      {reduceMotion ? null : <Animated.View testID={shimmerTestID} style={[styles.shimmer, shimmerStyle]} />}
    </View>
  );
}

// Heights of an ItemRow's two lines, so a placeholder row is as tall as the row it stands for.
const TITLE_LINE = 22;
const SUBTITLE_LINE = 18;
const TITLE_GAP = 2;

export interface ItemRowSkeletonsProps {
  /** How many rows to draw. */
  count?: number;
  /** The size of the row's leading picture, in points. */
  leadingSize: number;
  /** A round picture (a mascot, a chat) or a rounded square (a folder tile). */
  leadingShape: "round" | "tile";
  density?: "compact" | "comfortable";
  /** Space between the picture and the text, as in the row. */
  gap?: SpaceStep;
  testID?: string;
}

/**
 * Placeholders in the shape of the ItemRows that replace them: the same
 * height, picture and two lines, with no card the real rows do not have.
 */
export function ItemRowSkeletons({
  count = 3,
  leadingSize,
  leadingShape,
  density = "compact",
  gap = 12,
  testID,
}: ItemRowSkeletonsProps) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} testID={testID} style={[styles.row, styles[density]]}>
          <Skeleton
            testID={testID ? `${testID}-picture` : undefined}
            style={[
              { width: leadingSize, height: leadingSize, marginRight: space[gap] },
              leadingShape === "round" ? styles.round : styles.tile,
            ]}
          />
          <View testID={testID ? `${testID}-lines` : undefined} style={styles.lines}>
            <View testID={testID ? `${testID}-title-line` : undefined} style={styles.titleLine}>
              <Skeleton style={[styles.bar, styles.titleBar]} />
            </View>
            <View testID={testID ? `${testID}-subtitle-line` : undefined} style={styles.subtitleLine}>
              <Skeleton style={[styles.bar, styles.subtitleBar]} />
            </View>
          </View>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {
    overflow: "hidden",
    backgroundColor: theme.v2.colors.skeleton,
  },
  shimmer: {
    position: "absolute",
    top: -40,
    bottom: -40,
    left: 0,
    width: 72,
    backgroundColor: theme.v2.colors.skeletonHighlight,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  // The same padding as ItemRow's densities.
  compact: {
    paddingVertical: theme.v2.space[10],
  },
  comfortable: {
    paddingVertical: theme.v2.space[12],
  },
  round: {
    borderRadius: theme.v2.radius.full,
  },
  tile: {
    borderRadius: theme.v2.radius.card,
  },
  lines: {
    flex: 1,
    gap: TITLE_GAP,
  },
  titleLine: {
    height: TITLE_LINE,
    justifyContent: "center",
  },
  subtitleLine: {
    height: SUBTITLE_LINE,
    justifyContent: "center",
  },
  bar: {
    borderRadius: theme.v2.radius.full,
  },
  titleBar: {
    width: "55%",
    height: 14,
  },
  subtitleBar: {
    width: "35%",
    height: 11,
  },
}));
