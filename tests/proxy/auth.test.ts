import { describe, expect, it } from "vitest";
import {
  buildFundedProxyApiKey,
  buildProxyApiKey,
  isAuthorizedProxyAdminRequest,
  parseFundedProxyApiKey,
  parseProxyApiKey,
} from "../../packages/proxy/src/auth.js";

describe("proxy auth", () => {
  it("rejects admin requests when no proxy auth token is configured", () => {
    const headers = new Headers({ authorization: "Bearer anything" });

    expect(isAuthorizedProxyAdminRequest(headers, undefined)).toBe(false);
  });

  it("requires a matching bearer token for proxy admin requests", () => {
    expect(
      isAuthorizedProxyAdminRequest(
        new Headers({ authorization: "Bearer proxy-admin-token" }),
        "proxy-admin-token",
      ),
    ).toBe(true);
    expect(
      isAuthorizedProxyAdminRequest(
        new Headers({ authorization: "Bearer wrong-token" }),
        "proxy-admin-token",
      ),
    ).toBe(false);
  });

  it("accepts only HMAC-scoped proxy API keys", () => {
    const key = buildProxyApiKey("alice", "proxy-shared-secret");

    expect(parseProxyApiKey(key, "proxy-shared-secret")).toEqual({ handle: "alice" });
    expect(parseProxyApiKey("sk-proxy-alice", "proxy-shared-secret")).toBeNull();
    expect(parseProxyApiKey(key, "wrong-secret")).toBeNull();
  });

  it("keeps funded relay credentials in a distinct HMAC audience", () => {
    const sharedSecret = "proxy-shared-secret";
    const legacyKey = buildProxyApiKey("alice", sharedSecret);
    const fundedKey = buildFundedProxyApiKey("alice", sharedSecret);

    expect(fundedKey).not.toBe(legacyKey);
    expect(parseFundedProxyApiKey(fundedKey, sharedSecret)).toEqual({ handle: "alice" });
    expect(parseFundedProxyApiKey(legacyKey, sharedSecret)).toBeNull();
    expect(parseProxyApiKey(fundedKey, sharedSecret)).toBeNull();
  });
});
