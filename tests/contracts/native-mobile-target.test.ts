import { describe, expect, it } from "vitest";
import { loadNativeMobileTarget, nativeMobileTargetForOrigin, nativeMobileTargetPolicy } from "../../packages/contracts/src/native-mobile-target.js";

describe("fixed native mobile targets", () => {
  it("defaults to production and resolves only the exact operator selector", () => {
    expect(loadNativeMobileTarget({})).toBe("production");
    expect(loadNativeMobileTarget({ MATRIX_NATIVE_MOBILE_TARGET: "gmail-pilot" })).toBe("gmail-pilot");
    for (const value of ["", "pilot", " production", "https://gmail-pilot.matrix-os.com", "matrixos-gmail-pilot"])
      expect(() => loadNativeMobileTarget({ MATRIX_NATIVE_MOBILE_TARGET: value })).toThrow("Native mobile target unavailable");
  });
  it("maps origins to immutable exact IDs and callback addresses", () => {
    expect(nativeMobileTargetForOrigin(undefined)).toBe("production");
    expect(nativeMobileTargetForOrigin("https://gmail-pilot.matrix-os.com")).toBe("gmail-pilot");
    expect(() => nativeMobileTargetForOrigin("https://gmail-pilot.matrix-os.com/")).toThrow();
    expect(nativeMobileTargetPolicy("gmail-pilot")).toEqual({ target: "gmail-pilot", hostedOrigin: "https://gmail-pilot.matrix-os.com", applicationId: "com.matrixos.mobile.gmailpilot", scheme: "matrixos-gmail-pilot", ssoRedirectUri: "matrixos-gmail-pilot://sso-callback", integrationRedirectUri: "matrixos-gmail-pilot://integrations" });
    expect(Object.isFrozen(nativeMobileTargetPolicy("gmail-pilot"))).toBe(true);
    expect(() => nativeMobileTargetPolicy("unknown" as "production")).toThrow();
  });
});

it("resolves the real Expo TypeScript entry with pilot identity and Firebase settings intact", async () => {
 const {createRequire} = await import("node:module"); const {resolve} = await import("node:path");
 const root = resolve(process.cwd(), "apps/mobile");
 const {getConfig} = createRequire(resolve(root, "package.json"))("@expo/config");
 const saved = {...process.env};
 try {
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://gmail-pilot.matrix-os.com";
  process.env.GOOGLE_SERVICES_JSON = "/tmp/synthetic-google-services.json";
  const result = getConfig(root, {skipSDKVersionRequirement: true});
  expect(result.dynamicConfigPath).toBe(resolve(root, "app.config.ts"));
  expect(result.exp).toMatchObject({scheme: "matrixos-gmail-pilot", ios: {bundleIdentifier: "com.matrixos.mobile.gmailpilot"},
   android: {package: "com.matrixos.mobile.gmailpilot", googleServicesFile: "/tmp/synthetic-google-services.json"}, updates: {enabled: false}});
  process.env.EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN = "https://app.matrix-os.com";
  const production = getConfig(root, {skipSDKVersionRequirement: true}).exp;
  expect(production.scheme).toBe("matrixos"); expect(production.ios.bundleIdentifier).toBe("com.matrixos.mobile");
 } finally {
  for (const key of ["EXPO_PUBLIC_MATRIX_HOSTED_ORIGIN", "GOOGLE_SERVICES_JSON"]) {
   if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
 }
});
