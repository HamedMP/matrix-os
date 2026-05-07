import { describe, expect, it } from "vitest";
import {
  getProvisionVerificationTarget,
  getSignupFallbackRedirectUrl,
  isCustomerVpsUsableStatus,
} from "../../www/src/inngest/provision-status";

describe("www provisioning status helpers", () => {
  it("sends completed Clerk signups to the app domain by default", () => {
    expect(getSignupFallbackRedirectUrl({})).toBe("https://app.matrix-os.com");
  });

  it("allows an explicit signup fallback override", () => {
    expect(getSignupFallbackRedirectUrl({
      NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL: "https://preview.example",
    })).toBe("https://preview.example");
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
