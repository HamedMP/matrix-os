import { useEffect, useState } from "react";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { FADE_IN_MS } from "@/lib/chat-text-fade";

/** A run of text inside a paragraph that fades in on the UI thread. */
export function FadeInText({ revealedAt, children }: { revealedAt: number; children: string }) {
  // Measured from when the chunk was first shown rather than from mount, so a
  // span that remounts mid-fade (markdown re-parsing around it as text
  // arrives) carries on instead of flashing back to transparent.
  const [startOpacity] = useState(() => Math.min(1, Math.max(0, (Date.now() - revealedAt) / FADE_IN_MS)));
  const opacity = useSharedValue(startOpacity);

  useEffect(() => {
    opacity.set(withTiming(1, { duration: FADE_IN_MS * (1 - startOpacity) }));
  }, [opacity, startOpacity]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: opacity.get() }));

  return <Animated.Text style={animatedStyle}>{children}</Animated.Text>;
}
