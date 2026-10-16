import { describe, expect, it } from "vitest";
import { messagingPlatformUrl, resolveMessagingPlatformOrigin } from "../../packages/contracts/src/messaging-origin";

describe("operator messaging platform authority", () => {
  it("preserves production only for absent configuration", () => {
    expect(resolveMessagingPlatformOrigin()).toBe("https://app.matrix-os.com");
    expect(messagingPlatformUrl("/slack/install")).toBe("https://app.matrix-os.com/slack/install");
    expect(resolveMessagingPlatformOrigin(null)).toBeNull();
  });
  it.each(["", " ", " https://stage.example.com", "https://stage.example.com\n", "stage.example.com", "//stage.example.com",
    "http://stage.example.com", "https://user:password@stage.example.com", "https://@stage.example.com", "https://stage.example.com/path",
    "https://stage.example.com/?runtime=primary", "https://stage.example.com/#fragment", "javascript:alert(1)",
    "https://stage.example.com/../", "https://stage.example.com?", "https://stage.example.com#", "https://" + "a".repeat(2049)])(
    "fails closed without a production fallback for %s", (input) => {
      expect(resolveMessagingPlatformOrigin(input)).toBeNull();
      expect(messagingPlatformUrl("/slack/install", input)).toBeNull();
    });
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "allows only explicit development loopback origins: %s", (origin) => {
      expect(resolveMessagingPlatformOrigin(origin)).toBeNull();
      expect(resolveMessagingPlatformOrigin(origin, true)).toBe(origin);
    });
  it.each(["http://127.1:3000", "http://2130706433:3000", "http://localhost.attacker.example:3000", "http://127.0.0.2:3000", "http://10.0.0.1:3000", "http://stage.example.com"])(
    "rejects noncanonical/arbitrary HTTP even in development: %s", (origin) => expect(resolveMessagingPlatformOrigin(origin, true)).toBeNull());
  it("uses a canonical isolated HTTPS origin for only the fixed messaging paths", () => {
    expect(messagingPlatformUrl("/slack/install", "https://stage.example.com:8443")).toBe("https://stage.example.com:8443/slack/install");
    expect(resolveMessagingPlatformOrigin("https://localhost:3000")).toBe("https://localhost:3000");
    expect(resolveMessagingPlatformOrigin("https://stage.example.com/")).toBe("https://stage.example.com");
    expect(messagingPlatformUrl("/whatsapp/connect", "https://stage.example.com")).toBe("https://stage.example.com/whatsapp/connect");
  });
});
