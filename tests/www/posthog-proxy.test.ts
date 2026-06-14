import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// uBlock Origin's default privacy list blocks "/ingest/*^ip=" (a known
// PostHog reverse-proxy signature), so www must serve PostHog through the
// same /relay path the shell uses while keeping /ingest alive for cached
// bundles that still point at it.
describe("www PostHog proxy path", () => {
  const nextConfigSource = readFileSync(join(process.cwd(), "www/next.config.ts"), "utf8");
  const clientSource = readFileSync(join(process.cwd(), "www/src/lib/posthog-client.ts"), "utf8");

  it("rewrites /relay asset and ingest paths to PostHog EU", () => {
    expect(nextConfigSource).toContain("'/relay/static/:path*'");
    expect(nextConfigSource).toContain("'/relay/array/:path*'");
    expect(nextConfigSource).toContain("'/relay/:path*'");
    expect(nextConfigSource).toContain("https://eu-assets.i.posthog.com/static/:path*");
    expect(nextConfigSource).toContain("https://eu.i.posthog.com/:path*");
  });

  it("keeps legacy /ingest rewrites for cached client bundles", () => {
    expect(nextConfigSource).toContain("'/ingest/:path*'");
  });

  it("defaults the client api host to /relay instead of the blocklisted /ingest", () => {
    expect(clientSource).toMatch(/NEXT_PUBLIC_POSTHOG_API_HOST\s*\?\?\s*"\/relay"/);
    expect(clientSource).not.toMatch(/\?\?\s*"\/ingest"/);
  });
});

describe("www PostHog identify wiring", () => {
  const clientSource = readFileSync(join(process.cwd(), "www/src/lib/posthog-client.ts"), "utf8");
  const layoutSource = readFileSync(join(process.cwd(), "www/src/app/layout.tsx"), "utf8");
  const loginSource = readFileSync(join(process.cwd(), "www/src/app/login/[[...login]]/page.tsx"), "utf8");
  const signupSource = readFileSync(join(process.cwd(), "www/src/app/signup/[[...signup]]/page.tsx"), "utf8");
  const identifySource = readFileSync(
    join(process.cwd(), "www/src/components/PostHogIdentify.tsx"),
    "utf8",
  );

  it("exposes identify and reset helpers on the client wrapper", () => {
    expect(clientSource).toMatch(/export function identifyPostHogUser\(/);
    expect(clientSource).toMatch(/export function resetPostHogIdentity\(/);
  });

  it("keeps the global marketing layout free of Clerk client auth", () => {
    expect(layoutSource).not.toContain("ClerkProvider");
    expect(layoutSource).not.toContain("PostHogIdentify");
    expect(layoutSource).not.toContain("clerk.matrix-os.com");
  });

  it("mounts PostHogIdentify inside Clerk only on auth pages", () => {
    for (const source of [loginSource, signupSource]) {
      expect(source).toMatch(/<PostHogIdentify\s*\/>/);
      const clerkOpen = source.indexOf("<ClerkProvider>");
      const identify = source.indexOf("<PostHogIdentify");
      const clerkClose = source.indexOf("</ClerkProvider>");
      expect(clerkOpen).toBeGreaterThanOrEqual(0);
      expect(identify).toBeGreaterThan(clerkOpen);
      expect(identify).toBeLessThan(clerkClose);
    }
  });

  it("identifies with the Clerk user id and resets on sign-out", () => {
    expect(identifySource).toMatch(/useUser\(\)/);
    expect(identifySource).toMatch(/identifyPostHogUser\(user\.id/);
    expect(identifySource).toMatch(/resetPostHogIdentity\(\)/);
  });
});
