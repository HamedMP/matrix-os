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
