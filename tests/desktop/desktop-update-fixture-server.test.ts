import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("desktop update fixture server", () => {
  it("prints a parseable channel manifest for packaged updater smoke tests", () => {
    const manifest = execFileSync(
      process.execPath,
      [
        join(root, "scripts/release/desktop-update-fixture-server.mjs"),
        "--channel",
        "canary",
        "--version",
        "0.1.0-canary.20260819015415",
        "--print",
      ],
      { encoding: "utf8" },
    );

    expect(manifest).toContain("version: 0.1.0-canary.20260819015415");
    expect(manifest).toContain("files:");
    expect(manifest).toContain("url: fixture.zip");
    expect(manifest).toContain("sha512:");
    expect(manifest).toContain("releaseNotes: |-");
  });
});
