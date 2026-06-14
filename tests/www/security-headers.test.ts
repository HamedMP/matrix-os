import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function readRepoFile(path: string) {
  return readFile(resolve(root, path), "utf8");
}

describe("www Lighthouse security headers", () => {
  it("sets an enforced nonce CSP and COOP from the proxy", async () => {
    const proxy = await readRepoFile("www/src/proxy.ts");

    expect(proxy).toContain("Content-Security-Policy");
    expect(proxy).toContain("Cross-Origin-Opener-Policy");
    expect(proxy).toContain("x-nonce");
    expect(proxy).toContain("script-src");
    expect(proxy).toContain("'strict-dynamic'");
    expect(proxy).toContain("'nonce-${nonce}'");
    expect(proxy).not.toContain("Content-Security-Policy-Report-Only");
    expect(proxy).not.toContain("'unsafe-inline' 'unsafe-eval'");
  });

  it("keeps Clerk middleware scoped while applying security headers broadly", async () => {
    const proxy = await readRepoFile("www/src/proxy.ts");

    expect(proxy).toContain('createRouteMatcher(["/dashboard(.*)", "/admin(.*)"])');
    expect(proxy).toContain('"/((?!_next|.*\\\\..*).*)"');
    expect(proxy).toContain("return withClerk(request, event)");
    expect(proxy).toContain("return applySecurityHeaders");
  });

  it("passes the CSP nonce to the server-rendered landing JSON-LD script", async () => {
    const landing = await readRepoFile("www/src/app/page.tsx");

    expect(landing).toContain('headers()).get("x-nonce")');
    expect(landing).toContain('<script');
    expect(landing).toContain("nonce={nonce}");
    expect(landing).toContain("suppressHydrationWarning");
  });

  it("does not load browser-blocklisted analytics scripts on first paint", async () => {
    const [layout, client] = await Promise.all([
      readRepoFile("www/src/app/layout.tsx"),
      readRepoFile("www/src/lib/posthog-client.ts"),
    ]);

    expect(layout).not.toContain("@vercel/analytics");
    expect(layout).not.toContain("<Analytics");
    expect(client).toContain("autocapture: false");
    expect(client).toContain("capture_pageview: false");
  });
});
