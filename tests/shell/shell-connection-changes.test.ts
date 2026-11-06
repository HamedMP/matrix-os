import { describe, expect, it } from "vitest";
import { isConnectionChangeMessage } from "../../shell/src/components/onboarding-widget/use-shell-connection-changes.js";

describe("shell connection change messages", () => {
  it("reacts to connect, disconnect and expiry only", () => {
    for (const type of ["integration:connected", "integration:disconnected", "integration:expired"]) {
      expect(isConnectionChangeMessage(type)).toBe(true);
    }
    expect(isConnectionChangeMessage("chat:message")).toBe(false);
  });
});
