import { describe, expect, it } from "vitest";

function resolveAuthoritativeMessagingPath(input: {
  hasBridgeMapping: boolean;
  legacyAdapterEnabled: boolean;
}): "bridged-matrix" | "legacy-direct" | "notification-only" {
  if (input.hasBridgeMapping) {
    return input.legacyAdapterEnabled ? "notification-only" : "bridged-matrix";
  }
  return "legacy-direct";
}

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
});
