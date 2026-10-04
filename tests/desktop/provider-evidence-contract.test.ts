import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEvidenceDirectory } from "../e2e/desktop/fixtures/evidence-directory";
import { paintedContrast } from "../e2e/desktop/fixtures/contrast-pixels";

it("cleans owned captures on failure and preserves caller-owned evidence", () => {
  const owned = createEvidenceDirectory();
  try { writeFileSync(join(owned.path, "failure.png"), "synthetic"); } finally { owned.cleanup(); }
  expect(existsSync(owned.path)).toBe(false);
  const external = mkdtempSync(join(tmpdir(), "matrix-evidence-contract-"));
  try {
    const captures = createEvidenceDirectory(external);
    writeFileSync(join(external, "failure.png"), "synthetic"); captures.cleanup();
    expect(existsSync(join(external, "failure.png"))).toBe(true);
  } finally { rmSync(external, { recursive: true, force: true }); }
});
it("CI runs all provider Settings regressions and retains their captures at the uploaded path", () => {
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const section = ci.slice(ci.indexOf("- name: Run required Electron Desktop provider Settings regressions"), ci.indexOf("- name: Run required MAT-335"));
  for (const file of ["provider-auth-terminal", "agents-providers-figma", "agents-providers-button-contrast"]) expect(section).toContain(`${file}.e2e.test.ts`);
  expect(section).toContain("MATRIX_SETTINGS_EVIDENCE_DIR: output/playwright/settings-providers");
  expect(section).toContain("path: output/playwright/settings-providers/");
});
it("measures complete disabled group opacity without claiming disabled WCAG conformance", () => {
  const opaque = [{ background: [0, 0, 0, 1], opacity: 1 }];
  const faded = [{ background: [0, 0, 0, 1], opacity: .45 }, { background: [0, 0, 0, 1], opacity: 1 }];
  expect(paintedContrast([1, 1, 1, 1], opaque)).toBe(21);
  expect(paintedContrast([1, 1, 1, 1], faded)).toBeCloseTo(4.412, 2);
  expect(paintedContrast([1, 1, 1, 1], faded)).toBeLessThan(4.5);
});
