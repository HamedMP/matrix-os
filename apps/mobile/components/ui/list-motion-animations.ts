import { FadeOut, LinearTransition } from "react-native-reanimated";

import { motion } from "@/lib/theme-v2";

// Reanimated skips these with Reduce Motion on, as it does every layout animation.

/** How rows of a list move into place when one before them comes or goes. */
export const listItemLayout = LinearTransition.duration(motion.duration.base);

/** How a row that leaves a list goes. */
export const listItemExit = FadeOut.duration(motion.duration.fast);
