import type { AppEntry, AppWindow } from "@/hooks/useWindowManager";
import { sharedLauncherAppEntry } from "@/hooks/useSharedLauncherApps";
import { sharedAppWindowPath } from "@/lib/shared-app-target";

const SHARED_APP_WINDOW_PREFIX = "__shared-app__:";

/**
 * The launcher identity behind a running window, for its dock, taskbar, and chrome icons.
 * A shared window resolves only from the owner-scoped target it was opened with, so the
 * recipient's own app with the same slug, or a system app with the same name, can never
 * lend it artwork. A window without a matching identity keeps its title and no artwork.
 */
export function windowAppEntry(
  windowRecord: Pick<AppWindow, "path" | "title" | "sharedAppTarget">,
  apps: readonly AppEntry[],
): AppEntry {
  const target = windowRecord.sharedAppTarget;
  if (target) {
    return sharedAppWindowPath(target) === windowRecord.path
      ? sharedLauncherAppEntry(target)
      : { name: windowRecord.title, path: windowRecord.path };
  }
  if (windowRecord.path.startsWith(SHARED_APP_WINDOW_PREFIX)) {
    return { name: windowRecord.title, path: windowRecord.path };
  }
  return apps.find((candidate) => (
    windowRecord.path === candidate.path || windowRecord.path.startsWith(`${candidate.path}:`)
  )) ?? { name: windowRecord.title, path: windowRecord.path };
}
