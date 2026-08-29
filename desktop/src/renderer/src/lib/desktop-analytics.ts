export const DESKTOP_ANALYTICS_EVENT = "matrix:desktop-analytics";

export type DesktopAnalyticsName =
  | "desktop_app_opened"
  | "desktop_app_focused"
  | "desktop_app_minimized"
  | "desktop_app_closed"
  | "desktop_launcher_toggled"
  | "desktop_shown"
  | "desktop_icon_moved"
  | "desktop_icon_removed";

const DESKTOP_ANALYTICS_NAMES = new Set<DesktopAnalyticsName>([
  "desktop_app_opened",
  "desktop_app_focused",
  "desktop_app_minimized",
  "desktop_app_closed",
  "desktop_launcher_toggled",
  "desktop_shown",
  "desktop_icon_moved",
  "desktop_icon_removed",
]);

export function isDesktopAnalyticsName(value: unknown): value is DesktopAnalyticsName {
  return typeof value === "string" && DESKTOP_ANALYTICS_NAMES.has(value as DesktopAnalyticsName);
}

export interface DesktopAnalyticsDetail {
  name: DesktopAnalyticsName;
  appKind?: string;
  open?: boolean;
}

const SAFE_VALUE = /^[a-z0-9_-]{1,64}$/i;

export function trackDesktopEvent(detail: DesktopAnalyticsDetail): void {
  if (typeof window === "undefined") return;
  const safeDetail: DesktopAnalyticsDetail = { name: detail.name };
  if (detail.appKind && SAFE_VALUE.test(detail.appKind)) safeDetail.appKind = detail.appKind;
  if (typeof detail.open === "boolean") safeDetail.open = detail.open;
  window.dispatchEvent(new CustomEvent<DesktopAnalyticsDetail>(DESKTOP_ANALYTICS_EVENT, { detail: safeDetail }));
}
