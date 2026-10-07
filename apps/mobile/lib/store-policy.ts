import { Platform } from "react-native";

/**
 * Store policy for purchase calls to action — the single place that decides
 * whether this build may link to, or encourage, paying outside the app.
 *
 * The current native build conservatively hides plan, pricing, portal, and
 * checkout links. Only the web build keeps them; unknown platforms fail closed.
 * This is our build policy, not proof of Apple's 3.1.3(f) companion exception
 * or a universal rule for every storefront. Any native purchase route needs
 * its own eligibility, entitlement, disclosure, and release verification.
 *
 * Screens ask this helper instead of checking `Platform.OS` themselves, so a
 * future storefront-aware exception (e.g. US App Store external purchase
 * links) only has to change this function.
 */
export function allowsExternalPurchaseLinks(platform: typeof Platform.OS = Platform.OS): boolean {
  return platform === "web";
}
