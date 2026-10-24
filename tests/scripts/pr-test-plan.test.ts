import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { planPrTests } from "../../scripts/ci/pr-test-plan.mjs";
import { mentionPatterns } from "../../scripts/ci/unit-test-selection.mjs";

const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"));

describe("PR test planning", () => {
  it.each([
    "packages/gateway/src/agent-launcher.ts",
    "shell/src/components/Desktop.tsx",
    "scripts/ci/dedicated-backend.mjs",
    "tests/gateway/agent-launcher.test.ts",
    ".github/workflows/docker-test.yml",
    "distro/customer-vps/host-bin/matrix-sync-agent",
    "Dockerfile",
  ])("selects affected unit tests when only %s changes", (path) => {
    expect(planPrTests([path, "docs/dev/notes.md"]).unitScope).toBe("affected");
  });

  it.each([
    "package.json",
    "packages/gateway/package.json",
    "pnpm-lock.yaml",
    "tsconfig.base.json",
    "vitest.config.ts",
    "tests/setup.ts",
    "scripts/ci/test-sequencer.ts",
    "scripts/ci/pr-test-plan.mjs",
    "scripts/ci/unit-test-selection.mjs",
    ".github/workflows/ci.yml",
    "packages/kernel/src/index.ts",
    "packages/observability/src/client.ts",
    "packages/terminal-runtime/src/index.ts",
    "packages/platform/src/migrations/0001_init.sql",
    "packages/gateway/src/coding-agents/codex-exec-contract.json",
    "shell/src/app/globals.css",
    "home/system/desktop.json",
  ])("runs the full unit suite when %s changes", (path) => {
    expect(planPrTests(["packages/gateway/src/server.ts", path]).unitScope).toBe("full");
  });

  it.each([
    "scripts/ci/dedicated-backend.mjs",
    ".github/workflows/preview-vps.yml",
    "tests/scripts/ci-fast-workflow.test.ts",
    "tests/platform/customer-vps.test.ts",
    "apps/mobile/src/app.tsx",
    "distro/customer-vps/cloud-init.yaml",
  ])("skips E2E when only %s changes", (path) => {
    expect(planPrTests([path, "README.md"]).e2eTests).toBe(false);
  });

  it.each([
    "shell/src/components/Desktop.tsx",
    "desktop/src/main/index.ts",
    "packages/gateway/src/server.ts",
    "packages/platform/src/db.ts",
    "tests/e2e/terminal-soft-grid.e2e.test.ts",
    "tests/fixtures/gateway/server.ts",
    ".github/workflows/ci.yml",
    "pnpm-lock.yaml",
    "home/system/desktop.json",
  ])("runs E2E when %s changes", (path) => {
    expect(planPrTests(["scripts/ci/dedicated-backend.mjs", path]).e2eTests).toBe(true);
  });

  it("treats docs-only changes as needing neither lane", () => {
    expect(planPrTests(["docs/dev/fast-ci.md", "specs/605-priority-linux-ci/spec.md"])).toEqual({
      unitScope: "affected",
      e2eTests: false,
    });
  });

  it("matches tests that read a changed file or scan its folder", () => {
    expect(mentionPatterns([".github/workflows/preview-vps.yml", "packages/gateway/src/server.ts", "Dockerfile"])).toEqual([
      ".github/workflows/preview-vps.yml",
      ".github/workflows",
      "packages/gateway/src/server.ts",
      "Dockerfile",
    ]);
  });
});

describe("CI wiring for PR test planning", () => {
  const outputs = workflow.jobs.changes.outputs;
  const unitSteps = workflow.jobs.unit.steps as Array<{ id?: string; if?: string; run?: string; env?: Record<string, string> }>;

  it("defaults to full coverage when the plan is missing", () => {
    expect(outputs.unit_scope).toBe("${{ steps.changed.outputs.unit_scope || 'full' }}");
    expect(outputs.e2e_tests).toBe("${{ steps.changed.outputs.e2e_tests || 'true' }}");
  });

  it("runs selected files only after a successful selection", () => {
    const select = unitSteps.find((step) => step.id === "select");
    expect(select?.if).toContain("needs.changes.outputs.unit_scope == 'affected'");
    // The import graph resolves workspace packages through their built dist output.
    expect(select?.run).toMatch(/^bun run test:prepare && node scripts\/ci\/unit-test-selection\.mjs /u);
    const test = unitSteps.find((step) => step.run?.startsWith('GITHUB_SHA="$UNIT_SOURCE_SHA" bun run test --'));
    expect(test?.env?.UNIT_SELECTION).toBe("${{ steps.select.outputs.list }}");
    expect(test?.env?.MATRIX_TEST_WORKERS).toBe("${{ runner.environment == 'self-hosted' && '6' || '2' }}");
    expect(test?.run).toContain('${UNIT_SELECTION:+--passWithNoTests $(cat "$UNIT_SELECTION")}');
  });

  it("skips E2E only when the plan says so", () => {
    expect(workflow.jobs.e2e.if).toContain("needs.changes.outputs.e2e_tests != 'false'");
  });
});
