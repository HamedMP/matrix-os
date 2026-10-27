import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, openSync, closeSync, ftruncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditRepository, isTestEntrypoint, readReviewLedger } from "../../scripts/testing/audit-test-suite.mjs";

const fixtures: string[] = [];
afterEach(() => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repository(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "matrix-test-audit-"));
  fixtures.push(root);
  execFileSync("git", ["init", "-q", root]);
  for (const [name, contents] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), contents);
  }
  execFileSync("git", ["-C", root, "add", "."]);
  return root;
}

describe("test effectiveness census", () => {
  it("includes integration, Python, package, inline, and browser entrypoints without treating fixtures as tests", () => {
    for (const name of ["tests/a.test.ts", "tests/a.integration.ts", "shell/e2e/a.spec.ts", "packages/a/src/a.test.mjs", "tests/test_a.py", "tests/a_test.py", "tests/a.bats", "tests/__fixtures__/demo.test.ts", "tests/deploy/host.test.py", "macos/Tests/AppTests/AuthTests.swift"]) {
      expect(isTestEntrypoint(name)).toBe(true);
    }
    for (const name of ["tests/helpers/a.ts", "specs/a/spec.md", "tests/__fixtures__/demo.ts", "node_modules/a/a.test.ts", "tests/test-utils.ts"]) {
      expect(isTestEntrypoint(name)).toBe(false);
    }
  });

  it("reports every discovered file as screened, never reviewed or useless from heuristic signals", () => {
    const root = repository({ "tests/a.test.ts": 'import { it, expect } from "vitest"; it("a", () => expect(1).toBe(1));' });
    const report = auditRepository(root);
    expect(report.files).toHaveLength(1);
    expect(report.files[0].signals).toContain("no-direct-production-import");
    expect(report.files[0].decision).toBe("needs-review");
    expect(report.summary.sourceReviewed).toBe(0);
    expect(report.summary.faultVerified).toBe(0);
    expect(report.summary.completeSourceReview).toBe(false);
  });

  it("reads configured collection globs and flags a tracked suite outside them", () => {
    const root = repository({
      "vitest.config.ts": 'export default {test: {include: ["tests/**/*.test.ts"], exclude: ["tests/e2e/**"]}}',
      "tests/unit/a.test.ts": 'import { parse } from "../../packages/a";',
      "tests/e2e/a.test.ts": "test.skip('a', () => {});",
      "packages/a/src/a.test.ts": "test('a', () => {});",
    });
    const report = auditRepository(root);
    expect(report.files.find(file => file.path === "tests/unit/a.test.ts")?.configuredCollectors).toEqual(["vitest.config.ts"]);
    expect(report.files.find(file => file.path === "tests/e2e/a.test.ts")?.configuredCollectors).toEqual([]);
    expect(report.summary.collectorUnresolved).toBe(2);
    expect(report.files.every(file => file.executionVerified === false)).toBe(true);
  });

  it("invalidates source reviews after the reviewed test changes", () => {
    const root = repository({ "tests/a.test.ts": "it('first', () => {});" });
    const first = auditRepository(root);
    const review = { path: first.files[0].path, sourceSha256: first.files[0].sourceSha256, reviewer: "engineer", evidenceDepth: "source-reviewed", decision: "strengthen", rationale: "No production behavior exercised." };
    expect(auditRepository(root, [review]).summary.sourceReviewed).toBe(1);
    writeFileSync(join(root, "tests/a.test.ts"), "it('changed', () => {});");
    const changed = auditRepository(root, [review]);
    expect(changed.summary.sourceReviewed).toBe(0);
    expect(changed.files[0].signals).toContain("stale-review");
  });

  it("recognizes the mobile Jest character-class glob while refusing dynamic collection", () => {
    const root = repository({
      "apps/mobile/jest.config.js": 'module.exports = {testMatch: ["**/__tests__/**/*.test.[jt]s?(x)"]};',
      "apps/mobile/__tests__/terminal.test.tsx": "test('terminal', () => {});",
      "packages/a/vitest.config.ts": "export default {test: {include: [dynamicScope]}};",
      "packages/a/test/a.test.ts": "it('a', () => {});",
    });
    const report = auditRepository(root);
    expect(report.files.find(file => file.path.endsWith("terminal.test.tsx"))?.configuredCollectors).toEqual(["apps/mobile/jest.config.js"]);
    expect(report.files.find(file => file.path.endsWith("a.test.ts"))?.configuredCollectors).toEqual([]);
  });

  it("does not mistake comments or coverage includes for test collection", () => {
    const root = repository({
      "vitest.config.ts": '// include: ["tests/**/*.test.ts"]\nexport default {test: {include: dynamic, coverage: {include: ["tests/**/*.test.ts"]}}};',
      "tests/a.test.ts": "it('a', () => {});",
    });
    expect(auditRepository(root).files[0].configuredCollectors).toEqual([]);
    writeFileSync(join(root, "vitest.config.ts"), 'export default {test: {include: ["tests/**/*.test.ts"], exclude: dynamicExcludes}};');
    expect(auditRepository(root).files[0].configuredCollectors).toEqual([]);
    writeFileSync(join(root, "vitest.config.ts"), 'export default {test: {coverage: {include: ["tests/**/*.test.ts"]}}};');
    expect(auditRepository(root).files[0].configuredCollectors).toEqual([]);
  });

  it("respects an explicit config root and discovers prefixed Playwright configs", () => {
    const root = repository({
      "vitest.config.ts": 'export default {root: "nested", test: {include: ["tests/**/*.test.ts"]}};',
      "tests/a.test.ts": "it('outside', () => {});",
      "nested/tests/a.test.ts": "it('inside', () => {});",
      "tests/e2e/collaboration.playwright.config.ts": 'export default {testDir: ".", testMatch: /collaboration-project\\.spec\\.ts/};',
      "tests/e2e/collaboration-project.spec.ts": "test('collaboration', () => {});",
    });
    const report = auditRepository(root);
    expect(report.files.find(file => file.path === "tests/a.test.ts")?.configuredCollectors).toEqual([]);
    expect(report.files.find(file => file.path === "nested/tests/a.test.ts")?.configuredCollectors).toEqual(["vitest.config.ts"]);
    expect(report.files.find(file => file.path.endsWith("collaboration-project.spec.ts"))?.configuredCollectors).toEqual(["tests/e2e/collaboration.playwright.config.ts"]);
  });

  it("requires a concrete fault observation for fault-verified status", () => {
    const root = repository({ "tests/a.test.ts": "it('a', () => {});" });
    const [file] = auditRepository(root).files;
    const review = { path: file.path, sourceSha256: file.sourceSha256, reviewer: "engineer", evidenceDepth: "fault-verified", decision: "keep", rationale: "Exercises a production boundary." };
    expect(() => auditRepository(root, [review])).toThrow(/fault/);
    expect(auditRepository(root, [{ ...review, fault: "Removing route auth made this test fail with 200 instead of 401." }]).summary.faultVerified).toBe(1);
  });

  it("rejects duplicate and incomplete review rows instead of inflating completion", () => {
    const root = repository({ "tests/a.test.ts": "it('a', () => {});" });
    const [file] = auditRepository(root).files;
    const review = { path: file.path, sourceSha256: file.sourceSha256, reviewer: "engineer", evidenceDepth: "source-reviewed", decision: "keep", rationale: "Validated production behavior." };
    expect(() => auditRepository(root, [review, review])).toThrow(/duplicate/i);
    expect(() => auditRepository(root, [{ ...review, rationale: "" }])).toThrow(/review/i);
    expect(() => auditRepository(root, [{ ...review, path: "tests/renamed.test.ts" }])).toThrow(/unknown review/i);
  });

  it("labels HEAD separately from the dirty worktree inventory", () => {
    const root = repository({ "tests/a.test.ts": "it('a', () => {});" });
    execFileSync("git", ["-C", root, "-c", "user.name=Audit Fixture", "-c", "user.email=audit@example.invalid", "commit", "-qm", "fixture"]);
    const clean = auditRepository(root);
    expect(clean.headCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(clean.worktreeDirty).toBe(false);
    writeFileSync(join(root, "tests/a.test.ts"), "it('changed', () => {});");
    const changed = auditRepository(root);
    expect(changed.headCommit).toBe(clean.headCommit);
    expect(changed.worktreeDirty).toBe(true);
    expect(changed.inventorySha256).not.toBe(clean.inventorySha256);
  });

  it("includes new untracked tests but excludes ignored dependency trees", () => {
    const root = repository({ ".gitignore": "node_modules/\n", "tests/a.test.ts": "it('a', () => {});" });
    mkdirSync(join(root, "node_modules/a"), { recursive: true });
    writeFileSync(join(root, "node_modules/a/a.test.ts"), "it('ignored', () => {});");
    writeFileSync(join(root, "tests/new.test.ts"), "it('new', () => {});");
    expect(auditRepository(root).files.map(file => file.path)).toEqual(["tests/a.test.ts", "tests/new.test.ts"]);
  });

  it("includes per-registration evidence and exposes unconventional registration files", () => {
    const root = repository({
      "tests/mixed.test.ts": 'import {it,expect} from "vitest"; import {reduce} from "../src/reduce"; const copied = n => n+1; it("local",()=>expect(copied(1)).toBe(2)); it("real",()=>expect(reduce(1)).toBe(2));',
      "specs/evidence/probe.ts": 'import {it,expect} from "vitest"; it("historical probe",()=>expect(1).toBe(1));',
      "tests/helper.ts": 'import {expect} from "vitest"; export const check = v => expect(v).toBe(true);',
    });
    const report = auditRepository(root);
    expect(report.files[0].testDeclarations.map(test => test.classification)).toEqual(["local-only-candidate", "production-referenced"]);
    expect(report.registrationCandidates.map(file => file.path)).toEqual(["specs/evidence/probe.ts"]);
    expect(report.summary.syntacticJsTestDeclarations).toBe(2);
    expect(report.files[0].decision).toBe("needs-review");
  });

  it("rejects excessive review rows before populating its index", () => {
    const root = repository({ "tests/a.test.ts": "it('a', () => {});" });
    const reviews = Array.from({ length: 10_001 }, (_, index) => ({ path: `tests/${index}.test.ts`,
      sourceSha256: "a".repeat(64), reviewer: "engineer", evidenceDepth: "source-reviewed",
      decision: "keep", rationale: "Reviewed production behavior." }));
    expect(() => auditRepository(root, reviews)).toThrow(/review count limit/i);
  });

  it("bounds review file bytes before JSON parsing and preserves a valid small ledger", () => {
    const root = mkdtempSync(join(tmpdir(), "matrix-review-bytes-")); fixtures.push(root);
    const file = join(root, "reviews.json");
    const fd = openSync(file, "w");
    try { ftruncateSync(fd, 8 * 1024 * 1024 + 1); } finally { closeSync(fd); }
    expect(() => readReviewLedger(file)).toThrow(/review file size limit/i);
    writeFileSync(file, "[]");
    expect(readReviewLedger(file)).toEqual([]);
  });
});
