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
    expect(ciWorkflow).toContain("os_view_parity_tests: ${{ steps.changed.outputs.os_view_parity_tests }}");
    expect(ciWorkflow).toMatch(/^  os-view-parity:\n/mu);
    expect(ciWorkflow).toContain("OS View Parity");
    expect(ciWorkflow).toContain("OS_VIEW_PARITY_RESULT: ${{ needs.os-view-parity.result }}");
    expect(ciWorkflow).toContain("| OS View Parity | $OS_VIEW_PARITY_RESULT |");
    expect(ciWorkflow).toContain("actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6");
    expect(ciWorkflow).toContain("pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86 # v6");
    expect(ciWorkflow).toContain("actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6");
  });
});
