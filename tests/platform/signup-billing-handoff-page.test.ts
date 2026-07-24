import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getSignupBillingHandoffPage } from "../../packages/platform/src/signup-billing-handoff-page.js";

describe("platform signup billing handoff fallback", () => {
  it("renders the self-contained marketing layout with the official rabbit artwork", () => {
    const html = getSignupBillingHandoffPage({
      publishableKey: "pk_test_matrix",
      scriptNonce: "nonce-value",
      redirectTarget: "/?billing=setup&handoff=signup",
    });

    expect(html).toContain('data-matrix-auth-layout="platform-fallback"');
    expect(html).toContain('data-matrix-feature-showcase="product"');
    expect(html).toContain('data-matrix-signup-billing-handoff="true"');
    expect(html).toContain('viewBox="0 0 503 660"');
    expect(html.match(/viewBox="0 0 503 660"/g)).toHaveLength(3);

    const officialRabbit = readFileSync(
      join(process.cwd(), "shell/public/rabbit.svg"),
      "utf8",
    );
    const officialRabbitPaths = Array.from(
      officialRabbit.matchAll(/<path d="([^"]+)"/g),
      (match) => match[1],
    );
    expect(officialRabbitPaths).toHaveLength(11);
    for (const path of officialRabbitPaths) {
      expect(html.split(`d="${path}"`).length - 1).toBe(3);
    }

    for (const asset of [
      "shell/public/agents/claude-code.svg",
      "shell/public/agents/codex.svg",
      "shell/public/agents/cursor.svg",
    ]) {
      const officialAgent = readFileSync(join(process.cwd(), asset), "utf8");
      for (const match of officialAgent.matchAll(/<path d="([^"]+)"/g)) {
        expect(html).toContain(`d="${match[1]}"`);
      }
    }

    expect(html).toContain("<title>Anthropic</title>");
    expect(html).toContain("<title>OpenAI</title>");
    expect(html).toContain("<title>Cursor</title>");
    expect(html).not.toContain(">M</span>");
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
    expect(html).toContain("Matrix could not finish opening billing. Try again after a moment.");
    expect(html).toContain("window.location.replace(marketingSignInUrl)");
    expect(html).toContain(".card.failed .spinner { display: none; }");
    expect(html).not.toContain(".card.failed .spinner, .card.failed .status-rabbit");
    const retryScheduler = html.match(
      /function scheduleAuthShellRetry\(\) \{([\s\S]*?)\n    \}/,
    )?.[1];
    expect(retryScheduler).toBeDefined();
    expect(retryScheduler).not.toContain("clearTimeout(unresolvedTimer)");
    expect(html).not.toContain("AppSessionExchangeError");
  });
});
