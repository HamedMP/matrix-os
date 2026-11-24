import { useFeatureFlag } from "@matrix-os/ui/feature-flags";
import { createDesktopFeatureFlagSource } from "../../support/desktop-feature-flags";

/** PostHog flag that switches Electron Desktop Files to the redesigned UI (spec 2711). */
export const FILES_REDESIGN_FLAG = "desktop-files-redesign";

// One source for the renderer: the Files surface and its window frame read the same flag.
const source = createDesktopFeatureFlagSource();

/**
 * null while PostHog loads, then whether the redesign is on. Builds without a
 * PostHog project (local dev, self-hosted) get the redesign, matching how the
 * shared `useFeatureFlag` treats a missing source.
 */
export function useFilesRedesignFlag(): boolean | null {
  return useFeatureFlag(source, FILES_REDESIGN_FLAG);
}
