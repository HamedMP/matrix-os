import { Linking } from "react-native";

export const PRIVACY_POLICY_URL = "https://matrix-os.com/privacy";
export const TERMS_OF_SERVICE_URL = "https://matrix-os.com/terms";

/** Opens a published legal page in the system browser. These links sit on the
 * signed-out screen too, so a device that cannot open the URL must not surface
 * an unhandled rejection there. */
export function openLegalLink(url: string): void {
  Linking.openURL(url).catch((err: unknown) => {
    console.warn("[mobile] failed to open legal link", err instanceof Error ? err.name : "unknown");
  });
}
