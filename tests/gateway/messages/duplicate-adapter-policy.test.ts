import { describe, expect, it } from "vitest";
import { resolveAuthoritativeMessagingPath } from "../../../packages/gateway/src/messages/adapter-policy.js";

describe("duplicate adapter policy", () => {
  it("makes bridged Matrix authoritative when a bridge mapping exists", () => {
    expect(resolveAuthoritativeMessagingPath({
      hasBridgeMapping: true,
      legacyAdapterEnabled: false,
    })).toBe("bridged-matrix");
  });

  it("downgrades legacy adapters to notification-only when both paths exist", () => {
    expect(resolveAuthoritativeMessagingPath({
      hasBridgeMapping: true,
      legacyAdapterEnabled: true,
    })).toBe("notification-only");
  });

  it("keeps the legacy adapter authoritative until a bridge mapping exists", () => {
    expect(resolveAuthoritativeMessagingPath({
      hasBridgeMapping: false,
      legacyAdapterEnabled: true,
    })).toBe("legacy-direct");
  });

  it("returns none when no messaging path exists", () => {
    expect(resolveAuthoritativeMessagingPath({
      hasBridgeMapping: false,
      legacyAdapterEnabled: false,
    })).toBe("none");
  });
});
