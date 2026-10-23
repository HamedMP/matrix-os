export type NativeMobileTarget = "production" | "gmail-pilot";

const targets = Object.freeze({
  production: Object.freeze({ target: "production", hostedOrigin: "https://app.matrix-os.com", applicationId: "com.matrixos.mobile", scheme: "matrixos", ssoRedirectUri: "matrixos://sso-callback", integrationRedirectUri: "matrixos://integrations" }),
  "gmail-pilot": Object.freeze({ target: "gmail-pilot", hostedOrigin: "https://gmail-pilot.matrix-os.com", applicationId: "com.matrixos.mobile.gmailpilot", scheme: "matrixos-gmail-pilot", ssoRedirectUri: "matrixos-gmail-pilot://sso-callback", integrationRedirectUri: "matrixos-gmail-pilot://integrations" }),
});

/** Fixed operator selector, never a request/header or arbitrary redirect URL. */
export function loadNativeMobileTarget(env: Readonly<Record<string, string | undefined>>): NativeMobileTarget {
  const value = env.MATRIX_NATIVE_MOBILE_TARGET;
  if (value === undefined || value === "production") return "production";
  if (value === "gmail-pilot") return value;
  throw new Error("Native mobile target unavailable");
}

export function nativeMobileTargetForOrigin(origin: string | undefined): NativeMobileTarget {
  if (origin === undefined || origin === targets.production.hostedOrigin) return "production";
  if (origin === targets["gmail-pilot"].hostedOrigin) return "gmail-pilot";
  throw new Error("Native mobile target unavailable");
}

export function nativeMobileTargetPolicy(target: NativeMobileTarget = "production") {
  if (target !== "production" && target !== "gmail-pilot") throw new Error("Native mobile target unavailable");
  return targets[target];
}
