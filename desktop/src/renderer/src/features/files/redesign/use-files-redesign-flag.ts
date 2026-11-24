import { useFeatureFlag } from "@matrix-os/ui/feature-flags";
import { createDesktopFeatureFlagSource } from "../../support/desktop-feature-flags";

/** PostHog flag that switches Electron Desktop Files to the redesigned UI (spec 2711). */
export const FILES_REDESIGN_FLAG = "desktop-files-redesign";

// One source for the renderer: the Files surface and its window frame read the same flag.
const source = createDesktopFeatureFlagSource();
// Local opt-in for development builds, which usually have no PostHog project.
const devOptIn = import.meta.env.VITE_DESKTOP_FILES_REDESIGN === "1";

/**
 * The redesign is unfinished, so it is off unless PostHog turns the flag on or
 * a build sets VITE_DESKTOP_FILES_REDESIGN=1. Builds without PostHog
 * (self-hosted, CI) keep the current Files layout. null while PostHog loads.
 */
export function resolveFilesRedesign({ flag, hasSource, devOptIn: optIn }: { flag: boolean | null; hasSource: boolean; devOptIn: boolean }): boolean | null {
  if (optIn) return true;
  if (!hasSource) return false;
  return flag;
}

export function useFilesRedesignFlag(): boolean | null {
  const flag = useFeatureFlag(source, FILES_REDESIGN_FLAG);
  return resolveFilesRedesign({ flag, hasSource: source !== undefined, devOptIn });
}
