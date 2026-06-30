import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("self-host shell mode", () => {
  it("bypasses managed-cloud onboarding while preserving Clerk context for shared shell chrome", () => {
    const page = readFileSync(join(root, "shell/src/app/page.tsx"), "utf8");
    const layout = readFileSync(join(root, "shell/src/app/layout.tsx"), "utf8");

    expect(page).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(page).toContain("selfHostedMode || hasServerVerifiedMatrixSession");
    expect(layout).toContain('const selfHostedMode = process.env.MATRIX_SELF_HOSTED === "1"');
    expect(layout).toContain("{renderDocument(!selfHostedMode)}");
    expect(layout).not.toContain("return renderDocument(false);");
  });
});
