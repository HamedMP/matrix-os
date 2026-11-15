import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), ".github/workflows", file), "utf8");
const setSecrets = (workflow: string) => [...workflow.matchAll(/--set-secrets "([^"]+)"/g)].map((match) => match[1]!);

// The Gemini Live relay (/internal/containers/:handle/gemini-live) answers 503
// without GEMINI_API_KEY, which silently disables onboarding and live voice on
// every customer and preview computer.
describe("Gemini Live relay deployment", () => {
  it("binds the production Gemini Live key on the platform service", () => {
    expect(setSecrets(read("platform-cloud-run.yml")).some((list) => list.includes("GEMINI_API_KEY=platform-gemini-live-api-key:latest"))).toBe(true);
  });

  it("binds the preview-only Gemini Live key on platform previews", () => {
    const lists = setSecrets(read("preview-platform.yml"));
    expect(lists.some((list) => list.includes("GEMINI_API_KEY=platform-gemini-live-api-key-preview:latest"))).toBe(true);
    expect(lists.some((list) => list.includes("GEMINI_API_KEY=platform-gemini-live-api-key:latest"))).toBe(false);
  });
});
