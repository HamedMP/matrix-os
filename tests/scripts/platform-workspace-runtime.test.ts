import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = process.cwd();
const dockerfile = readFileSync(join(root, "Dockerfile.platform"), "utf8");
const dockerignore = readFileSync(join(root, ".dockerignore"), "utf8");
const cloudBuild = parse(readFileSync(join(root, "cloudbuild.platform.yaml"), "utf8"));
const previewWorkflow = readFileSync(join(root, ".github/workflows/preview-platform.yml"), "utf8");
const gateway = JSON.parse(readFileSync(join(root, "packages/gateway/package.json"), "utf8"));
const workspaces = readdirSync(join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(join(root, "packages", entry.name, "package.json")))
  .map((entry) => ({ path: `packages/${entry.name}`, manifest: JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")) }));

describe("Platform image workspace closure", () => {
  it("keeps the Gateway compiler below build memory limits without changing runtime memory", () => {
    const builder = dockerfile.split("FROM deps AS builder")[1]!.split("FROM base AS prod-deps")[0]!;
    const runtime = dockerfile.split("FROM node:24-alpine AS runtime")[1]!;

    expect(builder).toContain(
      "RUN NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter '@matrix-os/gateway' build",
    );
    expect(dockerfile).not.toContain("ENV NODE_OPTIONS");
    expect(runtime).not.toContain("NODE_OPTIONS");
    expect(cloudBuild.options?.machineType).toBe("E2_HIGHCPU_8");
  });

  it("keeps shell E2E sources out of the production image build context", () => {
    const ignoredPaths = dockerignore
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(ignoredPaths).toContain("tests");
    expect(ignoredPaths).toContain("shell/e2e");
  });

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

  it("stamps preview images with the exact checked-out head SHA", () => {
    expect(previewWorkflow).toContain("_MATRIX_BUILD_SHA=$head_sha");
    expect(previewWorkflow).not.toContain("_MATRIX_BUILD_SHA=$GITHUB_SHA");
  });
});
