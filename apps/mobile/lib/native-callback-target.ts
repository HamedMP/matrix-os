import * as Application from "expo-application";
import { Platform } from "react-native";
import { makeRedirectUri } from "expo-auth-session";
import { nativeMobileTargetForOrigin, nativeMobileTargetPolicy } from "@matrix-os/contracts/native-mobile-target";
import { HOSTED_GATEWAY_URL } from "./hosted-origin";

const policy = nativeMobileTargetPolicy(nativeMobileTargetForOrigin(HOSTED_GATEWAY_URL));
export const MOBILE_INTEGRATIONS_REDIRECT_URI = policy.integrationRedirectUri;

export class NativeCallbackTargetError extends Error {
  constructor() {
    super("Mobile connection unavailable");
    this.name = "NativeCallbackTargetError";
  }
}

/** Native module identity survives a changed Metro bundle/Expo manifest. */
export function nativeBuildTargetMatches(): boolean {
  return Platform.OS === "web" || ((Platform.OS === "ios" || Platform.OS === "android") && Application.applicationId === policy.applicationId);
}

export function assertNativeCallbackTarget(): void {
  if (!nativeBuildTargetMatches()) throw new NativeCallbackTargetError();
}

export function mobileSsoRedirectUri(override?: string): string {
  assertNativeCallbackTarget();
  // Expo Web has no installed native identity. Preserve its browser-origin
  // redirect semantics and existing operator override; this is not attestation.
  if (Platform.OS === "web") return override ?? makeRedirectUri({ scheme: policy.scheme, path: "sso-callback" });
  if (override !== undefined && override !== policy.ssoRedirectUri) throw new NativeCallbackTargetError();
  return policy.ssoRedirectUri;
}
