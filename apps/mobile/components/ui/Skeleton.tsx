import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  View,
  type StyleProp,
  type ViewProps,
  type ViewStyle,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";

export interface SkeletonProps extends Omit<ViewProps, "children" | "style"> {
  style?: StyleProp<ViewStyle>;
  shimmerTestID?: string;
}

export function Skeleton({ style, shimmerTestID, ...props }: SkeletonProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const animation = Animated.loop(Animated.timing(progress, {
      toValue: 1,
      duration: 1_250,
      easing: Easing.linear,
      isInteraction: false,
      useNativeDriver: true,
    }));
    animation.start();
    return () => animation.stop();
  }, [progress]);

  return (
    <View
      {...props}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.base, style]}
    >
      <Animated.View
        testID={shimmerTestID}
        style={[
          styles.shimmer,
          {
            transform: [
              { translateX: progress.interpolate({ inputRange: [0, 1], outputRange: [-120, 520] }) },
              { rotate: "12deg" },
            ],
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  base: {
    overflow: "hidden",
    backgroundColor: theme.v2.colors.accentSurface,
  },
  shimmer: {
    position: "absolute",
    top: -40,
    bottom: -40,
    left: 0,
    width: 72,
    backgroundColor: "rgba(255, 255, 255, 0.58)",
  },
}));
