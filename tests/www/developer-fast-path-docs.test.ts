import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("developer fast path docs", () => {
  it("makes the agent-first setup prompt the primary quickstart path", () => {
    const quickstart = readFileSync(join(root, "www/content/docs/users/quickstart.mdx"), "utf-8");
    const promptIndex = quickstart.indexOf("## Fastest path: paste the setup prompt");
    const manualIndex = quickstart.indexOf("## Manual setup");

    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(manualIndex).toBeGreaterThan(promptIndex);
    expect(quickstart).toContain("matrix login --profile cloud");
    expect(quickstart).toContain("matrix run -it --session setup -- gh auth login");
    expect(quickstart).toContain("Matrix-managed SSH key");
    expect(quickstart).toContain("Do not scan my local machine for credentials");
    expect(quickstart).toContain("Do not upload local private keys");
  });
});
