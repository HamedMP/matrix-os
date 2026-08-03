import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSignupBillingHandoffPage } from "../../packages/platform/src/signup-billing-handoff-page.js";

describe("platform signup billing handoff fallback", () => {
  it("renders the self-contained marketing layout from the existing Matrix artwork", () => {
    const html = getSignupBillingHandoffPage({
      publishableKey: "pk_test_matrix",
      scriptNonce: "nonce-value",
      redirectTarget: "/?billing=setup&handoff=signup",
    });

    expect(html).toContain('data-matrix-auth-layout="platform-fallback"');
    expect(html).toContain('data-matrix-feature-showcase="product"');
    expect(html).toContain('data-matrix-signup-billing-handoff="true"');
    expect(html).toContain('<span class="wordmark-text">matrix-os</span>');

    const existingMark = readFileSync(
      join(process.cwd(), "shell/public/matrix-logo.svg"),
      "utf8",
    );
    const existingMarkPaths = Array.from(
      existingMark.matchAll(/<path d="([^"]+)"/g),
      (match) => match[1],
    );
    expect(existingMarkPaths.length).toBeGreaterThan(0);
    for (const path of existingMarkPaths) {
      expect(html).toContain(`d="${path}"`);
    }

    expect(html).not.toContain('<span class="wordmark-text">Matrix OS</span>');
    expect(html).not.toContain("Orbitron");
    expect(html).not.toContain("Welcome back to Matrix");
    expect(html).not.toContain('data-matrix-platform-fallback-auth="true"');
  });

  it("keeps session exchange, bounded retry, timeout, and generic retry copy inline", () => {
    const html = getSignupBillingHandoffPage({
      publishableKey: "pk_test_matrix",
      scriptNonce: "nonce-value",
      redirectTarget: "/?billing=setup&handoff=signup",
    });

    expect(html).toContain("fetch('/api/auth/app-session'");
    expect(html).toContain("signal: AbortSignal.timeout(10000)");
    expect(html).toContain("var retryDelays = [2000, 3000, 4000];");
    expect(html).toContain("window.setTimeout(showRetryState, 12000)");
    expect(html).toContain("Billing settings are still loading");
    expect(html).toContain(
      "Matrix could not finish opening billing. Try again after a moment.",
    );
    expect(html).toContain("window.location.replace(marketingSignInUrl)");
    expect(html).toContain(".card.failed .spinner { display: none; }");
    expect(html).not.toContain("AppSessionExchangeError");
  });
});
