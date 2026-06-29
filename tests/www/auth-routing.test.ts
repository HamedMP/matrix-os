import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("www auth routing", () => {
  it("uses Clerk's canonical sign-up route from marketing CTAs", () => {
    const links = read("www/src/components/landing/links.ts");

    expect(links).toContain('SIGN_UP_HREF = "/sign-up"');
    expect(links).not.toContain('SIGN_UP_HREF = "/signup"');
    expect(existsSync(join(process.cwd(), "www/src/app/sign-up/[[...sign-up]]/page.tsx"))).toBe(true);
  });

  it("preserves legacy login alias path segments and query params", () => {
    const login = read("www/src/app/login/[[...login]]/page.tsx");

    expect(login).toContain("params: Promise");
    expect(login).toContain("searchParams: Promise");
    expect(login).toContain("segments.map(encodeURIComponent).join");
    expect(login).toContain('redirect(`/sign-in${suffix}${queryString ? `?${queryString}` : ""}`);');
  });

  it("forces completed marketing Clerk flows to the app domain", () => {
    const signIn = read("www/src/app/sign-in/[[...sign-in]]/page.tsx");
    const signUp = read("www/src/app/sign-up/[[...sign-up]]/page.tsx");

    expect(signIn).toContain("forceRedirectUrl={getMarketingAuthRedirectUrl()}");
    expect(signIn).toContain("fallbackRedirectUrl={getSigninFallbackRedirectUrl()}");
    expect(signUp).toContain("forceRedirectUrl={getMarketingAuthRedirectUrl()}");
  });

  it("routes preselected sign-ups through the metadata handoff", () => {
    const signUp = read("www/src/app/sign-up/[[...sign-up]]/page.tsx");

    expect(signUp).toContain("parsePlanUrlSlug");
    expect(signUp).toContain("/welcome?plan=");
    // falls back to the app domain when no plan is chosen
    expect(signUp).toContain("getMarketingAuthRedirectUrl()");
  });

  it("wraps the marketing app in ClerkProvider from the root layout", () => {
    const layout = read("www/src/app/layout.tsx");

    expect(layout).toContain('import { ClerkProvider } from "@clerk/nextjs";');
    expect(layout).toContain("<ClerkProvider>");
    expect(layout).toContain("</ClerkProvider>");
  });

  it("keeps auth pages under the root ClerkProvider instead of nesting providers", () => {
    const signIn = read("www/src/app/sign-in/[[...sign-in]]/page.tsx");
    const signUp = read("www/src/app/sign-up/[[...sign-up]]/page.tsx");

    expect(signIn).not.toContain("ClerkProvider");
    expect(signUp).not.toContain("ClerkProvider");
  });
});
