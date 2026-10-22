import { describe, expect, it } from "vitest";
import { loadGmailPipedreamAttemptConfig } from "../../packages/platform/src/gmail-pipedream-attempt-config.js";
import { isGmailPipedreamCallback } from "../../packages/platform/src/integration-public-path.js";
const enabled = { GMAIL_PIPEDREAM_ATTEMPTS_ENABLED: "true", PLATFORM_PUBLIC_URL: "https://app.matrix-os.com", GMAIL_PIPEDREAM_CALLBACK_LOGGING_EXCLUDED: "true" };
describe("Gmail Pipedream callback configuration", () => {
  it("defaults off without changing legacy or native eligibility", () => { expect(loadGmailPipedreamAttemptConfig({})).toBeUndefined(); });
  it("derives the exact callback from the configured platform origin", () => {
    expect(loadGmailPipedreamAttemptConfig(enabled)).toEqual({ callbackUrl: "https://app.matrix-os.com/api/integrations/gmail/pipedream/callback", environment: "production" });
  });
  it.each([undefined, "http://app.matrix-os.com", "https://other.example", "https://app.matrix-os.com/path", "https://user@app.matrix-os.com", "https://app.matrix-os.com/?q=1"])("fails closed on unusable origin %s", PLATFORM_PUBLIC_URL => {
    expect(() => loadGmailPipedreamAttemptConfig({ ...enabled, PLATFORM_PUBLIC_URL })).toThrow("Gmail connection receipts unavailable");
  });
  it("requires verified request-log exclusion before enabling a server-only callback URL", () => {
    expect(() => loadGmailPipedreamAttemptConfig({ ...enabled, GMAIL_PIPEDREAM_CALLBACK_LOGGING_EXCLUDED: undefined })).toThrow();
  });
  it("exempts only the exact POST callback path", () => {
    const path = "/api/integrations/gmail/pipedream/callback";
    expect(isGmailPipedreamCallback("POST", path)).toBe(true);
    for (const candidate of [path + "/", path + "/other", path + "-other", "/api/integrations/gmail/pipedream/attempts/id"]) expect(isGmailPipedreamCallback("POST", candidate)).toBe(false);
    expect(isGmailPipedreamCallback("GET", path)).toBe(false);
  });
});
