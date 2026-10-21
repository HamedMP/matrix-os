import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { requiresOsViewParityChecks } from "../../scripts/ci/os-view-parity-plan.mjs";

const ciWorkflow = readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

describe("OS-view parity CI path planning", () => {
  it.each([
    "shell/src/components/Desktop.tsx",
    "shell/src/components/desktop/DesktopWindow.tsx",
    "desktop/src/renderer/src/features/desktop-shell/NativeDesktopShell.tsx",
    "desktop/src/shared/app-error.ts",
    "packages/ui/src/button.tsx",
    "packages/brand/src/tokens.ts",
    "packages/contracts/src/canonical-chat.ts",
    "packages/contracts/src/coding-agents.ts",
    "packages/gateway/src/chat/routes.ts",
    "tests/fixtures/os-view-parity.ts",
    "tests/contracts/os-view.test.ts",
    "tests/shell/os-view-state-client.test.ts",
    "tests/desktop/os-view-state-client.test.ts",
    "tests/desktop/native-os-view-persistence.test.ts",
    "tests/gateway/os-view-state-repository.test.ts",
    "scripts/ci/os-view-parity-plan.mjs",
    ".github/workflows/ci.yml",
  ])("runs all surface checks when %s changes", (path) => {
    expect(requiresOsViewParityChecks([path])).toBe(true);
  });

  it("skips unrelated runtime-only changes", () => {
    expect(requiresOsViewParityChecks([
      "packages/cli/src/index.ts",
      "docs/dev/onboarding.md",
    ])).toBe(false);
  });

  it("wires the path plan into a dedicated aggregate CI gate", () => {
    expect(ciWorkflow).toContain("os_view_parity_tests: ${{ needs.redirect.outputs.routed == 'true' && 'false' || (steps.superseded.outputs.stale == 'true' && 'false' || steps.changed.outputs.os_view_parity_tests) }}");
    expect(ciWorkflow).toMatch(/^  os-view-parity:\n/mu);
    expect(ciWorkflow).toContain("OS View Parity");
    expect(ciWorkflow).toContain("OS_VIEW_PARITY_RESULT: ${{ needs.os-view-parity.result }}");
    expect(ciWorkflow).toContain("| OS View Parity | $OS_VIEW_PARITY_RESULT |");
    expect(ciWorkflow).toMatch(/^\s+(?:-\s+)?uses: actions\/checkout@[a-f0-9]{40}(?:\s+#.*)?$/m);
    expect(ciWorkflow).toContain("pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6");
    expect(ciWorkflow).toMatch(/^\s+(?:-\s+)?uses: actions\/setup-node@[a-f0-9]{40}(?:\s+#.*)?$/m);
  });
});
