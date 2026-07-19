import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("self-host shell mode", () => {
  it("bypasses managed-cloud onboarding without loading Clerk on bare IP installs", () => {
    const page = readFileSync(join(root, "shell/src/app/page.tsx"), "utf8");
    const layout = readFileSync(join(root, "shell/src/app/layout.tsx"), "utf8");
    const menuBar = readFileSync(join(root, "shell/src/components/MenuBar.tsx"), "utf8");
    const userButton = readFileSync(join(root, "shell/src/components/UserButton.tsx"), "utf8");
    const billingAccess = readFileSync(join(root, "shell/src/hooks/useMatrixBillingAccess.ts"), "utf8");
    const settings = readFileSync(join(root, "shell/src/components/Settings.tsx"), "utf8");
    const selfHostMode = readFileSync(join(root, "shell/src/lib/self-host-mode.ts"), "utf8");
    const win11StartMenu = readFileSync(join(root, "shell/src/components/taskbar/Win11StartMenu.tsx"), "utf8");

    expect(page).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(page).toContain("selfHostedMode || hasServerVerifiedMatrixSession");
    expect(layout).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(layout).toContain('data-matrix-self-hosted={selfHostedMode ? "1" : undefined}');
    expect(layout).toContain("if (selfHostedMode) {");
    expect(layout).toContain("return renderDocument(false);");
    expect(layout).toContain("<ClerkProvider>");
    expect(layout).toContain("{renderDocument(true)}");
    expect(menuBar).toContain("isSelfHostedDocument()");
    expect(userButton).toContain("SelfHostedUserButton");
    expect(billingAccess).toContain("useManagedMatrixBillingAccess");
    expect(billingAccess).not.toContain("isSelfHostedDocument");
    expect(settings).toContain("isSelfHostedRuntime()");
    expect(settings).toContain("showBillingSection={false}");
    expect(settings).toContain("function ManagedSettings");
    expect(selfHostMode).toContain('process.env.MATRIX_SELF_HOSTED === "1"');
    expect(win11StartMenu).not.toContain("@clerk/nextjs");
    expect(win11StartMenu).toContain("isSelfHostedDocument() ? null : <Win11ManagedAccountActions");
  });
});
