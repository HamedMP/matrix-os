import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();
const resourceManagerCss = join(repoRoot, "home/apps/resource-manager/src/styles.css");

describe("Resource Manager theme tokens", () => {
  it("uses Matrix shell tokens instead of app-local blue accents", async () => {
    const css = await readFile(resourceManagerCss, "utf8");

    expect(css).toContain("var(--matrix-primary");
    expect(css).toContain("var(--matrix-accent");
    expect(css).toContain("var(--matrix-success");
    expect(css).not.toContain("#356f8c");
    expect(css).not.toContain("#19495f");
    expect(css).not.toContain("#edf6fa");
    expect(css).not.toContain("#9db1bc");
  });
});
