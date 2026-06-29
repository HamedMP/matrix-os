import { describe, expect, it } from "vitest";
import {
  getMarketingAuthRedirectUrl,
  getProvisionVerificationTarget,
  getSigninFallbackRedirectUrl,
  getSignupFallbackRedirectUrl,
  isCustomerVpsUsableStatus,
} from "../../www/src/inngest/provision-status";

describe("www provisioning status helpers", () => {
  it("sends completed Clerk signups to the app domain by default", () => {
    expect(getSignupFallbackRedirectUrl({})).toBe("https://app.matrix-os.com");
  });

  it("forces completed marketing auth flows to the app domain", () => {
    expect(getMarketingAuthRedirectUrl({})).toBe("https://app.matrix-os.com");
    expect(getMarketingAuthRedirectUrl({
      NEXT_PUBLIC_MATRIX_APP_URL: "https://preview.matrix-os.com",
    })).toBe("https://preview.matrix-os.com");
  });

  it("allows an explicit signup fallback override", () => {
    expect(getSignupFallbackRedirectUrl({
      NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "https://preview.example",
    })).toBe("https://preview.example");
  });

  it("allows an explicit signin fallback override", () => {
    expect(getSigninFallbackRedirectUrl({})).toBe("https://app.matrix-os.com");
    expect(getSigninFallbackRedirectUrl({
      NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL: "https://signin-preview.example",
    })).toBe("https://signin-preview.example");
  });

  it("verifies customer VPS provisioning by machine status instead of legacy container port", () => {
    expect(getProvisionVerificationTarget("https://api.matrix-os.com/", "alice", {
      runtime: "customer_vps",
      machineId: "9f05824c-8d0a-4d83-9cb4-b312d43ff112",
    })).toEqual({
      runtime: "customer_vps",
      statusUrl: "https://api.matrix-os.com/vps/9f05824c-8d0a-4d83-9cb4-b312d43ff112/status",
    });
  });

  it("keeps legacy container verification for legacy provision responses", () => {
    expect(getProvisionVerificationTarget("https://api.matrix-os.com", "alice/dev", {})).toEqual({
      runtime: "legacy_container",
      containerUrl: "https://api.matrix-os.com/containers/alice%2Fdev",
    });
  });

  it("treats provisioning and recovering VPS states as usable for the app boot page", () => {
    expect(isCustomerVpsUsableStatus("provisioning")).toBe(true);
    expect(isCustomerVpsUsableStatus("recovering")).toBe(true);
    expect(isCustomerVpsUsableStatus("running")).toBe(true);
    expect(isCustomerVpsUsableStatus("failed")).toBe(false);
  });
});
