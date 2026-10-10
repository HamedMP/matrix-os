import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const stylesheet = (app: string) => readFileSync(new URL(`../../home/apps/${app}/src/design-refresh.css`, import.meta.url), "utf8");
describe("compact app layout safeguards", () => {
  it("keeps brief opacity feedback while removing movement for reduced motion", () => {
    for (const file of ["app-foundation.css", "theme.css"]) {
      const css = readFileSync(new URL(`../../home/apps/_shared/${file}`, import.meta.url), "utf8");
      const reduced = css.split("@media (prefers-reduced-motion: reduce)")[1];
      expect(reduced).toMatch(/animation:\s*none\s*!important/);
      expect(reduced).toMatch(/transition:\s*opacity\s+120ms\s+ease-out\s*!important/);
      expect(reduced).toMatch(/scroll-behavior:\s*auto\s*!important/);
    }
  });
  it("restores the weather location controls hidden by the older phone stylesheet", () => {
    expect(stylesheet("weather").split("@media (max-width: 760px)")[1]).toMatch(/\.sidebar\s*\{[^}]*display:\s*flex/);
  });
  it("keeps saved weather cities in one horizontal row on phones", () => {
    expect(stylesheet("weather").split("@media (max-width: 760px)")[1]).toMatch(/\.location-list\s*\{[^}]*flex-direction:\s*row/);
  });
  it("keeps the whole notes library scrollable when controls fill a short phone window", () => {
    const phone = stylesheet("notes").split("@media (max-width: 820px)")[1];
    expect(phone).toMatch(/\.sidebar\s*\{[^}]*overflow-y:\s*auto/);
    expect(phone).toMatch(/\.note-list\s*\{[^}]*flex-shrink:\s*0/);
  });
  it("gives the new-note control a theme surface in standalone dark mode", () => {
    expect(stylesheet("notes")).toMatch(/\.icon-button,\s*\.button,\s*\.search-field\s*\{\s*background:\s*var\(--card\)/);
  });
  it("bounds Weather search results inside a panel whose close bar cannot shrink", () => {
    const css = readFileSync(new URL("../../home/apps/weather/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.search-panel\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*max-height:\s*72dvh/);
    expect(css).toMatch(/\.search-bar\s*\{[^}]*flex-shrink:\s*0/);
    expect(css).toMatch(/\.search-results\s*\{[^}]*min-height:\s*0;[^}]*flex:\s*0 1 auto;[^}]*overflow-y:\s*auto/);
  });
  it("matches selected Clock repeat days to the accent foreground", () => {
    const css = readFileSync(new URL("../../home/apps/clock/src/styles.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.day--on\s*\{[^}]*background:\s*var\(--app-accent\);[^}]*color:\s*var\(--app-primary-fg\)/);
  });
});
