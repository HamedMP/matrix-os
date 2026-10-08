import { useEffect, useState } from "react";
import { Animated, Easing } from "react-native";

import { Icon, LoadingIcon } from "@/components/ui";

import { useReduceMotion } from "./use-reduce-motion";

const TURN_MS = 900;

export interface SpinnerProps {
  size: number;
  color: string;
  /** Names what is in progress. Without it the spinner is decorative. */
  accessibilityLabel?: string;
  testID?: string;
}

/** The loading icon, turning. It stays still when the person has asked for reduced motion. */
export function Spinner({ size, color, accessibilityLabel, testID }: SpinnerProps) {
  const reduceMotion = useReduceMotion();
  const [turn] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (reduceMotion) return;
    const animation = Animated.loop(Animated.timing(turn, {
      toValue: 1,
      duration: TURN_MS,
      easing: Easing.linear,
      // An endless animation would otherwise hold back everything that waits
      // for interactions to finish, such as focusing the composer.
      isInteraction: false,
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, turn]);

  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });

  return (
    <Animated.View
      testID={testID}
      accessible={accessibilityLabel !== undefined}
      accessibilityRole={accessibilityLabel ? "progressbar" : undefined}
      accessibilityLabel={accessibilityLabel}
      accessibilityElementsHidden={accessibilityLabel === undefined}
      importantForAccessibility={accessibilityLabel ? "yes" : "no-hide-descendants"}
      style={{ transform: [{ rotate }] }}
    >
      <Icon icon={LoadingIcon} size={size} color={color} />
    </Animated.View>
  );
}
