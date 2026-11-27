import { describe, expect, it } from "vitest";
import { isOutlookOAuthCallback, outlookOAuthSignInReturn, resolveOutlookIntegrationConfig } from "../../packages/platform/src/outlook-integration.js";

const callback = "/api/integrations/outlook/oauth/callback";
const authorize = "/api/integrations/outlook/oauth/authorize";
const env = {
  MATRIX_OUTLOOK_ENABLED: "true",
  MATRIX_OUTLOOK_CLIENT_ID: "99c876a4-a5bd-4ad4-82ab-80a7d58ca7ad",
  MATRIX_OUTLOOK_CLIENT_SECRET: "entra-app-secret",
  MATRIX_OUTLOOK_CREDENTIAL_KEY: "18".repeat(32),
};

describe("platform Outlook setup", () => {
  it("admits only the exact callback method and path without session auth", () => {
    expect(isOutlookOAuthCallback("POST", callback)).toBe(true);
    expect(isOutlookOAuthCallback("GET", callback)).toBe(false);
    expect(isOutlookOAuthCallback("POST", authorize)).toBe(false);
    expect(isOutlookOAuthCallback("POST", callback + "/extra")).toBe(false);
  });

  it("returns unsigned browsers to the validated consent state after login", () => {
    const state = "x".repeat(43);
    const url = `https://app.matrix-os.com${authorize}?state=${state}&redirect=https://example.com`;
    expect(outlookOAuthSignInReturn("GET", url)).toBe(`${authorize}?state=${state}`);
    expect(outlookOAuthSignInReturn("GET", url + "&state=duplicate")).toBeNull();
    expect(outlookOAuthSignInReturn("POST", url)).toBeNull();
  });

  it("enables Outlook independently of Pipedream and rejects incomplete or reused secrets", () => {
    expect(resolveOutlookIntegrationConfig({})).toBeUndefined();
    expect(resolveOutlookIntegrationConfig(env)).toMatchObject({
      redirectUri: `https://app.matrix-os.com${callback}`, legacyRetired: false,
    });
    expect(resolveOutlookIntegrationConfig({ ...env, MATRIX_OUTLOOK_LEGACY_RETIRED: "true" })?.legacyRetired).toBe(true);
    expect(() => resolveOutlookIntegrationConfig({ MATRIX_OUTLOOK_ENABLED: "true" })).toThrow();
    expect(() => resolveOutlookIntegrationConfig({ ...env, PIPEDREAM_CLIENT_SECRET: env.MATRIX_OUTLOOK_CREDENTIAL_KEY })).toThrow();
  });
});
