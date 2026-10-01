import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const dockerfile = readFileSync(join(root, "Dockerfile.platform"), "utf8");
const gateway = JSON.parse(readFileSync(join(root, "packages/gateway/package.json"), "utf8"));
const workspaces = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
  .map((entry) => ({ path: `packages/${entry.name}`, manifest: JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) }));

describe("Platform image workspace closure", () => {
  it("makes every Gateway workspace dependency resolvable before frozen installation", () => {
    const base = dockerfile.split("FROM base AS deps")[0];
    for (const [name, version] of Object.entries(gateway.dependencies)) {
      if (version !== "workspace:*") continue;
      const workspace = workspaces.find((item) => item.manifest.name === name);
      expect(workspace, name).toBeDefined();
      expect(base, name).toContain(`COPY ${workspace!.path}/package.json ${workspace!.path}/package.json`);
    }
  });

  it("ships the scoped protocol and compiled terminal exports used by Gateway", () => {
    const runtime = dockerfile.split("FROM node:24-alpine AS runtime")[1];
    for (const [workspace, artifact] of [["scope-runtime", "src"], ["terminal-runtime", "dist"]]) {
      expect(runtime).toContain(`/app/packages/${workspace}/package.json ./packages/${workspace}/package.json`);
      expect(runtime).toContain(`/app/packages/${workspace}/${artifact} ./packages/${workspace}/${artifact}`);
    }
  });
});
