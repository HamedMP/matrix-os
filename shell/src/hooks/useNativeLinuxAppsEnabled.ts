"use client";

import { useFeatureFlagEnabled } from "posthog-js/react";

export const NATIVE_LINUX_APPS_FEATURE_FLAG = "native-linux-apps";

export function useNativeLinuxAppsEnabled(): boolean {
  return useFeatureFlagEnabled(NATIVE_LINUX_APPS_FEATURE_FLAG) === true;
}
