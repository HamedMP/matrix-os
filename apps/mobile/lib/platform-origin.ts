import { resolveMessagingPlatformOrigin } from "@matrix-os/contracts";

// Expo statically substitutes this exact public env access. Never use a selected
// computer, server response or saved connection to choose the platform authority.
const origin = resolveMessagingPlatformOrigin(
  process.env.EXPO_PUBLIC_MATRIX_APP_URL,
  typeof __DEV__ !== "undefined" && __DEV__,
);
if (!origin) throw new Error("Matrix platform configuration unavailable.");
export const MOBILE_PLATFORM_ORIGIN = origin;

/** SecureStore keys permit only alphanumerics, '.', '-' and '_'. */
const namespace = origin === "https://app.matrix-os.com" ? ""
  : `_${Array.from(origin, (char) => char.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;

/** Used only for persisted platform/runtime data; never Clerk credentials or device preferences. */
export function mobilePlatformStorageKey(productionKey: string): string {
  return `${productionKey}${namespace}`;
}
export const MOBILE_GATEWAY_CONNECTION_KEY = mobilePlatformStorageKey("matrix_os_gateway_connection");
