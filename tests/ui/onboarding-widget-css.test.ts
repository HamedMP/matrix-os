import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync("packages/ui/src/onboarding-widget/onboarding-widget.css", "utf8");

describe("onboarding widget styles", () => {
  it("animates the working pulse from the shared green token, not a hardcoded color", () => {
    const pulse = css.match(/@keyframes mxo-pulse \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(pulse).toContain("var(--mxo-green)");
    expect(pulse).not.toMatch(/rgba?\(|#[0-9a-f]{3,8}\b/i);
  });
});
