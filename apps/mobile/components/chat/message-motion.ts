import { Easing, FadeIn, FadeInDown, FadeOut } from "react-native-reanimated";

import { motion } from "@/lib/theme-v2";

// A strong ease-out: most of the way in the first few frames, then settling.
const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

// How far below its place a new message starts.
const RISE = 12;

/** A message arriving rises into place from the composer as it fades in. */
export const messageEntering = FadeInDown.duration(motion.duration.base)
  .easing(EASE_OUT)
  .withInitialValues({ opacity: 0, transform: [{ translateY: RISE }] });

/** With reduced motion a new message only fades in. */
export const messageEnteringReduced = FadeIn.duration(motion.duration.base);

/** The greeting and suggestions fade out as the first message takes their place. */
export const chatHomeExit = FadeOut.duration(motion.duration.fast);
