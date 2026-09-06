import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("dependency patch packaging", () => {
  it.each(["Dockerfile", "Dockerfile.platform"])("copies patches before installing dependencies in %s", (file) => {
    const source = readFileSync(file, "utf8");
    const copy = source.indexOf("COPY patches/ patches/");
    expect(copy).toBeGreaterThanOrEqual(0);
    expect(copy).toBeLessThan(source.indexOf("RUN pnpm install"));
  });

  it("ships patch files alongside host bundle package metadata", () => {
    const source = readFileSync("scripts/build-host-bundle.sh", "utf8");
    expect(source).toContain('cp -a "$ROOT_DIR/patches" "$STAGE_DIR/app/patches"');
  });
});
