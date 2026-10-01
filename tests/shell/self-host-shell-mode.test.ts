import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("self-host shell mode", () => {
  it("bypasses managed-cloud onboarding without loading Clerk on bare IP installs", () => {
    const page = readFileSync(join(root, "shell/src/app/page.tsx"), "utf8");
    const layout = readFileSync(join(root, "shell/src/app/layout.tsx"), "utf8");
    const shellHome = readFileSync(join(root, "shell/src/components/ShellHome.tsx"), "utf8");
    const userButton = readFileSync(join(root, "shell/src/components/UserButton.tsx"), "utf8");
    const billingAccess = readFileSync(join(root, "shell/src/hooks/useMatrixBillingAccess.ts"), "utf8");
    const settings = readFileSync(join(root, "shell/src/components/Settings.tsx"), "utf8");
    const selfHostMode = readFileSync(join(root, "shell/src/lib/self-host-mode.ts"), "utf8");
    const win11StartMenu = readFileSync(join(root, "shell/src/components/taskbar/Win11StartMenu.tsx"), "utf8");

    expect(page).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(page).toContain("selfHostedMode || hasServerVerifiedMatrixSession");
    expect(layout).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(layout).toContain('data-matrix-self-hosted={selfHostedMode ? "1" : undefined}');
    expect(layout).toContain("if (selfHostedMode || localAuthBypass) {");
    expect(layout).toContain("return renderDocument(false);");
    expect(layout).toContain("<ClerkProvider>");
    expect(layout).toContain("{renderDocument(true)}");
    expect(shellHome).toContain("if (isSelfHostedRuntime()) {");
    expect(shellHome).toContain("userId={SELF_HOSTED_SHELL_USER_ID}");
    expect(shellHome).toContain("function ClerkShellHome(");
    expect(shellHome).toContain("const { userId, sessionId } = useAuth();");
    expect(userButton).toContain("SelfHostedUserButton");
    expect(billingAccess).toContain("useManagedMatrixBillingAccess");
    expect(billingAccess).not.toContain("isSelfHostedDocument");
    expect(settings).toContain("isSelfHostedRuntime()");
    expect(settings).toContain("showBillingSection={false}");
    expect(settings).toContain("function ManagedSettings");
    expect(selfHostMode).toContain('process.env.MATRIX_SELF_HOSTED === "1"');
    expect(selfHostMode).toContain('SELF_HOSTED_SHELL_USER_ID = "self-hosted-owner"');
    expect(win11StartMenu).not.toContain("@clerk/nextjs");
    expect(win11StartMenu).toContain("isSelfHostedDocument() ? null : <Win11ManagedAccountActions");
  });

  it("does not invoke Clerk identity hooks when the explicit local bypass is enabled", () => {
    const layout = readFileSync(join(root, "shell/src/app/layout.tsx"), "utf8");
    const shellHome = readFileSync(join(root, "shell/src/components/ShellHome.tsx"), "utf8");

    expect(layout).toContain('const localAuthBypass = process.env.NEXT_PUBLIC_E2E_TEST_BYPASS === "1"');
    expect(layout).toContain("if (selfHostedMode || localAuthBypass) {");
    expect(layout).toContain("return renderDocument(false);");
    expect(shellHome).toContain("if (localAuthBypass) {");
    expect(shellHome).toContain("<ShellHomeContent {...props} userId={null} sessionId={null} />");
    expect(shellHome).toContain("function ManagedShellHome(props: ShellHomeProps)");
  });
});
