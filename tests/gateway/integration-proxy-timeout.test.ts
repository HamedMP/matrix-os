import { describe, expect, it } from "vitest";
import { getIntegrationProxyTimeoutMsForPath } from "../../packages/gateway/src/server.js";

describe("integration proxy timeout selection", () => {
  it("uses the extended onboarding timeout for the original gateway path", () => {
    expect(getIntegrationProxyTimeoutMsForPath("/api/integrations/onboarding/recommendations")).toBe(90_000);
  });

  it("does not depend on platform-internal upstream URL shape", () => {
    expect(getIntegrationProxyTimeoutMsForPath("/internal/containers/alice/integrations/onboarding/recommendations")).toBe(30_000);
  });
});
