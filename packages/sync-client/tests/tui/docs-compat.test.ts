import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "../../../..");

describe("CLI TUI docs compatibility", () => {
  it("documents default TUI and direct command behavior in public docs and README", async () => {
    const publicDocs = await readFile(join(root, "www/content/docs/guide/cli.mdx"), "utf8");
    const readme = await readFile(join(root, "packages/sync-client/README.md"), "utf8");

    expect(publicDocs).toContain("Running `matrix` with no arguments opens the Matrix OS terminal UI");
    expect(publicDocs).toContain("Direct commands");
    expect(readme).toContain("interactive TUI");
    expect(readme).toContain("Direct commands remain script-safe");
  });

  it("keeps package publish validation aware of the TUI entrypoint", async () => {
    const checkPublish = await readFile(join(root, "packages/sync-client/scripts/check-publish.mjs"), "utf8");

    expect(checkPublish).toContain("src/cli/tui/index.ts");
  });
});
