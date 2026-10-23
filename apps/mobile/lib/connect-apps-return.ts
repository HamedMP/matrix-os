// Connect Apps opens from the Apps tab and from Settings, but a sign-in can
// only come back to this binary's fixed address, which is the Apps tab's screen. The latest sign-in's
// starting point decides where that link lands, so one begun in Settings
// returns to Settings instead of closing it.

import { MOBILE_INTEGRATIONS_REDIRECT_URI } from "./native-callback-target";
export type ConnectAppsOrigin = "apps" | "settings";
const RETURN_LINK = new RegExp(`^${MOBILE_INTEGRATIONS_REDIRECT_URI}/?(?:[?#].*)?$`);
const SETTINGS_CONNECT_APPS = "/settings-detail/connect-apps";

let latestSignInFrom: ConnectAppsOrigin = "apps";

/** Called as a sign-in leaves the app for the browser. */
export function noteConnectAppsSignIn(from: ConnectAppsOrigin): void {
  latestSignInFrom = from;
}

/** Where a link from outside the app should open: Settings' Connect Apps for a sign-in begun there, else the link itself. */
export function connectAppsReturnPath(path: string): string {
  return latestSignInFrom === "settings" && RETURN_LINK.test(path) ? SETTINGS_CONNECT_APPS : path;
}
