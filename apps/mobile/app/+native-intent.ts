import { connectAppsReturnPath } from "@/lib/connect-apps-return";

/** Expo Router's hook for links from outside the app, before they are opened. */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  return connectAppsReturnPath(path);
}
