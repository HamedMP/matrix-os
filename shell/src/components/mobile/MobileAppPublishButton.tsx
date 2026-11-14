"use client";

import { AppSiteButton } from "@/components/app-sites/AppSiteButton";
import { publishingAppSlugFromPath } from "@/components/app-viewer-helpers";

/**
 * Web Mobile's Publish app entry for the open owner app. It sits in the compact status
 * header (Web Mobile has no window chrome); shared apps opened from someone else stay
 * read-only. The hit area extends to 44px around the 28px control for touch.
 */
export function MobileAppPublishButton({ path, shared }: { path: string; shared: boolean }) {
  const appSlug = shared || path.startsWith("__") ? null : publishingAppSlugFromPath(path);
  if (!appSlug) return null;
  return (
    <AppSiteButton
      appSlug={appSlug}
      triggerClassName="relative h-6 px-2 text-[11px] after:absolute after:-inset-x-1 after:-inset-y-2.5 after:content-['']"
    />
  );
}
