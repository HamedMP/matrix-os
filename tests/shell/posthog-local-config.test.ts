import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("local PostHog configuration", () => {
  it("documents the canonical web and Electron variables", () => {
    const example = readFileSync(join(process.cwd(), ".env.example"), "utf8");

    expect(example).toContain("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=");
    expect(example).toContain("NEXT_PUBLIC_POSTHOG_HOST=https://eu.posthog.com");
    expect(example).toContain("NEXT_PUBLIC_POSTHOG_API_HOST=/relay");
    expect(example).toContain("VITE_POSTHOG_PROJECT_TOKEN=");
    expect(example).toContain("VITE_POSTHOG_HOST=https://eu.posthog.com");
    expect(example).toContain("desktop.localhost");
  });
});
