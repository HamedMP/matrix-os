import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

  it.each(readdirSync(".").filter((file) => /^docker-compose.*\.yml$/.test(file)))("mounts patches with package metadata in %s", (file) => {
    const compose = parse(readFileSync(file, "utf8"));
    for (const service of Object.values(compose.services ?? {}) as { volumes?: string[] }[]) {
      const volumes = service.volumes ?? [];
      if (volumes.includes("./package.json:/app/package.json")) {
        expect(volumes).toContain("./patches:/app/patches:ro");
      }
    }
  });

});
