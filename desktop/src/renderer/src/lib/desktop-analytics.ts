import {
  DesktopAnalyticsDetailSchema,
  type DesktopAnalyticsDetail,
} from "../../../shared/desktop-analytics";

export { DesktopAnalyticsDetailSchema, type DesktopAnalyticsDetail };

export const DESKTOP_ANALYTICS_EVENT = "matrix:desktop-analytics";

export function trackDesktopEvent(detail: DesktopAnalyticsDetail): boolean {
  if (typeof window === "undefined") return false;
  const parsed = DesktopAnalyticsDetailSchema.safeParse(detail);
  if (!parsed.success) return false;
  window.dispatchEvent(new CustomEvent<DesktopAnalyticsDetail>(DESKTOP_ANALYTICS_EVENT, {
    detail: parsed.data,
  }));
  return true;
}
