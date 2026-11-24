import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge does not know the ds- text sizes, so it would treat
// `text-ds-ui` (a size) and `text-ds-primary-foreground` (a colour) as the same
// group and drop one. Registering the sizes keeps both.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["ds-ui-lg", "ds-ui", "ds-ui-sm", "ds-ui-xs", "ds-cap"] }],
    },
  },
});

/** Class combiner for design-system components and anything that uses ds- utilities. */
export function dsCn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}
