import { describe, expect, it } from "vitest";
import {
  CLERK_SATELLITE_RETURN_ORIGINS,
  clerkAllowedRedirectOrigins,
  clerkSatelliteReturnTarget,
} from "../../shell/src/lib/clerk-satellite-return";

// Fault detected: a Matrix sign-in/sign-up started on the ai-insights.app Clerk
// satellite must return to the exact page the visitor came from, while every
// look-alike or non-https address is refused (open redirect).
const satelliteReturn = "https://ai-insights.app/share?__clerk_synced=false#report=abc&tab=2";

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("clerkSatelliteReturnTarget", () => {
  it("returns an ai-insights.app address with its path, query and fragment intact", () => {
    expect(clerkSatelliteReturnTarget(satelliteReturn)).toBe(satelliteReturn);
    expect(clerkSatelliteReturnTarget("https://ai-insights.app/")).toBe("https://ai-insights.app/");
    expect(clerkSatelliteReturnTarget("https://ai-insights.app")).toBe("https://ai-insights.app/");
    expect(clerkSatelliteReturnTarget("https://ai-insights.app?__clerk_synced=false"))
      .toBe("https://ai-insights.app/?__clerk_synced=false");
  });

  it.each([
    ["look-alike suffix host", "https://ai-insights.app.evil.com/share"],
    ["userinfo before an attacker host", "https://ai-insights.app@evil.com/share"],
    ["attacker userinfo on the satellite host", "https://evil.com@ai-insights.app/share"],
    ["empty userinfo", "https://@ai-insights.app/share"],
    ["plain http", "http://ai-insights.app/share"],
    ["subdomain", "https://www.ai-insights.app/share"],
    ["longer registrable name", "https://ai-insights.appx/share"],
    ["prefixed registrable name", "https://xai-insights.app/share"],
    ["non-default port", "https://ai-insights.app:8443/share"],
    ["explicit default port", "https://ai-insights.app:443/share"],
    ["upper-case host", "https://AI-INSIGHTS.APP/share"],
    ["percent-encoded host", "https://ai-insights%2Eapp/share"],
    ["trailing-dot host", "https://ai-insights.app./share"],
    ["protocol-relative", "//ai-insights.app/share"],
    ["relative path", "/share"],
    ["backslash authority", "https:\\\\ai-insights.app\\share"],
    ["backslash after host", "https://ai-insights.app\\@evil.com"],
    ["embedded whitespace", "https://ai-insights.app/share\n"],
    ["leading whitespace", " https://ai-insights.app/share"],
    ["javascript scheme", "javascript:alert(1)//https://ai-insights.app/"],
    ["unparseable", "https://"],
    ["oversized", `https://ai-insights.app/${"a".repeat(2_048)}`],
    ["empty", ""],
  ])("refuses %s", (_label, value) => {
    expect(clerkSatelliteReturnTarget(value)).toBeNull();
  });

  it("refuses non-string and repeated redirect_url values", () => {
    expect(clerkSatelliteReturnTarget(undefined)).toBeNull();
    expect(clerkSatelliteReturnTarget([satelliteReturn])).toBeNull();
    expect(clerkSatelliteReturnTarget([satelliteReturn, satelliteReturn])).toBeNull();
    expect(clerkSatelliteReturnTarget(42)).toBeNull();
  });

  it("allowlists exact https origins with no wildcard", () => {
    expect(CLERK_SATELLITE_RETURN_ORIGINS).toEqual(["https://ai-insights.app", "https://matrix.page"]);
  });
});

// Fault detected: a Matrix.page allowlist visitor signs in on Matrix and must land
// back on the same shared app, never on onboarding and never on another
// matrix.page path (frames, assets, data or a look-alike publication).
describe("clerkSatelliteReturnTarget for Matrix.page shared apps", () => {
  const app = "https://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2";

  it("returns only the canonical publication URL, keeping Clerk sync markers", () => {
    expect(clerkSatelliteReturnTarget(app)).toBe(app);
    expect(clerkSatelliteReturnTarget(`${app}?__clerk_synced=false`)).toBe(`${app}?__clerk_synced=false`);
  });

  it.each([
    ["site root", "https://matrix.page/"],
    ["bare origin", "https://matrix.page"],
    ["friendly path", "https://matrix.page/sales-crm"],
    ["frame route", `${app}/frame`],
    ["access route", `${app}/access/email`],
    ["trailing slash", `${app}/`],
    ["upper-case id", app.toUpperCase().replace("HTTPS://MATRIX.PAGE", "https://matrix.page")],
    ["dot segment", `https://matrix.page/x/../a2fd72d0-0926-49d5-b45f-bbfb167e50d2`],
    ["encoded slash", "https://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2%2Fframe"],
    ["subdomain", "https://www.matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2"],
    ["plain http", "http://matrix.page/a2fd72d0-0926-49d5-b45f-bbfb167e50d2"],
  ])("refuses %s", (_label, value) => {
    expect(clerkSatelliteReturnTarget(value)).toBeNull();
  });
});

describe("clerkAllowedRedirectOrigins", () => {
  it("keeps Clerk's production defaults and adds only the exact satellite origin", () => {
    const key = `pk_live_${base64("clerk.matrix-os.com$")}`;
    expect(clerkAllowedRedirectOrigins(key)).toEqual([
      "https://matrix-os.com",
      "https://*.matrix-os.com",
      "https://ai-insights.app",
      "https://matrix.page",
    ]);
  });

  it("keeps Clerk's development defaults, including the frontend API origin", () => {
    const key = `pk_test_${base64("quiet-fox-12.clerk.accounts.dev$")}`;
    expect(clerkAllowedRedirectOrigins(key)).toEqual([
      "https://quiet-fox-12.accounts.dev",
      "https://*.quiet-fox-12.accounts.dev",
      "https://quiet-fox-12.clerk.accounts.dev",
      "https://ai-insights.app",
      "https://matrix.page",
    ]);
  });

  it("leaves Clerk's own defaults in place when the publishable key is missing or malformed", () => {
    expect(clerkAllowedRedirectOrigins(undefined)).toBeUndefined();
    expect(clerkAllowedRedirectOrigins("")).toBeUndefined();
    expect(clerkAllowedRedirectOrigins("pk_live_example")).toBeUndefined();
    expect(clerkAllowedRedirectOrigins(`pk_live_${base64("clerk.matrix-os.com")}`)).toBeUndefined();
    expect(clerkAllowedRedirectOrigins(`sk_live_${base64("clerk.matrix-os.com$")}`)).toBeUndefined();
    expect(clerkAllowedRedirectOrigins(`pk_live_${base64("evil host/$")}`)).toBeUndefined();
  });
});
