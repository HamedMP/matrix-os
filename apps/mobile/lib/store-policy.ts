import { Platform } from "react-native";

/**
 * Store policy for purchase calls to action — the single place that decides
 * whether this build may link to, or encourage, paying outside the app.
 *
 * Native store builds (iOS App Store Guideline 3.1.1 / 3.1.3(f) companion-app
 * exception, Google Play payments policy) must not show plan, pricing, portal,
 * or checkout links. Only the web build keeps them. Unknown native platforms
 * fail closed.
 *
 * Screens ask this helper instead of checking `Platform.OS` themselves, so a
 * future storefront-aware exception (e.g. US App Store external purchase
 * links) only has to change this function.
 */
export function allowsExternalPurchaseLinks(platform: typeof Platform.OS = Platform.OS): boolean {
  return platform === "web";
}
