import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as tar from "tar";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeBundledDependencyEdges } from "../../packages/sync-client/scripts/pack-cli.mjs";

// npm treats every dependency of a bundled package as part of the bundle and
// skips fetching it on `npm install -g`. These tests cover the tarball rewrite
// that keeps a globally installed CLI from losing zod and micromark (ENG-300).
describe("removeBundledDependencyEdges", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "matrix-pack-cli-test-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function buildTarball(input: {
    root: Record<string, unknown>;
    bundled: Record<string, unknown>;
  }): Promise<string> {
    const pkgDir = join(workDir, "src", "package");
    const bundledDir = join(pkgDir, "node_modules", "@matrix-os", "contracts");
    await mkdir(join(pkgDir, "bin"), { recursive: true });
    await mkdir(join(bundledDir, "src"), { recursive: true });
    await writeFile(join(pkgDir, "package.json"), JSON.stringify(input.root, null, 2));
    await writeFile(join(pkgDir, "bin", "matrix.mjs"), "#!/usr/bin/env node\n", { mode: 0o755 });
    await writeFile(join(bundledDir, "package.json"), JSON.stringify(input.bundled, null, 2));
    await writeFile(join(bundledDir, "src", "index.ts"), "export const contract = 1;\n");
    const tarball = join(workDir, "cli.tgz");
    await tar.c({ gzip: true, file: tarball, cwd: join(workDir, "src"), portable: true }, ["package"]);
    return tarball;
  }

  async function readTarball(tarball: string) {
    const out = join(workDir, `out-${Math.random().toString(16).slice(2)}`);
    await mkdir(out, { recursive: true });
    await tar.x({ file: tarball, cwd: out });
    const read = (path: string) => readFile(join(out, "package", path), "utf8");
    return { read, readJson: async (path: string) => JSON.parse(await read(path)) };
  }

  const root = {
    name: "@finnaai/matrix",
    version: "1.2.3",
    bundledDependencies: ["@matrix-os/contracts"],
    dependencies: { "@matrix-os/contracts": "0.0.1", zod: "^4.6.6", micromark: "^4.0.2" },
  };

  it("removes dependency edges from bundled manifests and keeps every other file", async () => {
    const tarball = await buildTarball({
      root,
      bundled: {
        name: "@matrix-os/contracts",
        version: "0.0.1",
        exports: { ".": "./src/index.ts" },
        dependencies: { zod: "^4.6.6", micromark: "^4.0.2" },
        devDependencies: { typescript: "^5.9.3" },
      },
    });

    const removed = await removeBundledDependencyEdges(tarball);

    expect(removed).toEqual([{ name: "@matrix-os/contracts", dependencies: ["micromark", "zod"] }]);
    const result = await readTarball(tarball);
    const bundled = await result.readJson("node_modules/@matrix-os/contracts/package.json");
    expect(bundled.dependencies).toBeUndefined();
    expect(bundled.devDependencies).toBeUndefined();
    expect(bundled).toMatchObject({ name: "@matrix-os/contracts", exports: { ".": "./src/index.ts" } });
    expect(await result.readJson("package.json")).toEqual(root);
    expect(await result.read("bin/matrix.mjs")).toBe("#!/usr/bin/env node\n");
    expect(await result.read("node_modules/@matrix-os/contracts/src/index.ts")).toBe(
      "export const contract = 1;\n",
    );
  });

  it("refuses a bundled dependency the CLI does not install itself", async () => {
    const tarball = await buildTarball({
      root,
      bundled: {
        name: "@matrix-os/contracts",
        version: "0.0.1",
        dependencies: { zod: "^4.6.6", "left-pad": "^1.3.0" },
      },
    });

    await expect(removeBundledDependencyEdges(tarball)).rejects.toThrow(/left-pad/);
  });

  it("refuses a bundled dependency whose version range differs from the CLI's", async () => {
    const tarball = await buildTarball({
      root,
      bundled: {
        name: "@matrix-os/contracts",
        version: "0.0.1",
        dependencies: { zod: "^3.25.0" },
      },
    });

    await expect(removeBundledDependencyEdges(tarball)).rejects.toThrow(/zod/);
  });

  it("refuses bundled peer or optional dependencies it cannot guarantee", async () => {
    const tarball = await buildTarball({
      root,
      bundled: {
        name: "@matrix-os/contracts",
        version: "0.0.1",
        peerDependencies: { react: "^19.0.0" },
      },
    });

    await expect(removeBundledDependencyEdges(tarball)).rejects.toThrow(/peerDependencies/);
  });

  it("fails when a declared bundled dependency is absent from the tarball", async () => {
    const tarball = await buildTarball({
      root: { ...root, bundledDependencies: ["@matrix-os/contracts", "@matrix-os/missing"] },
      bundled: { name: "@matrix-os/contracts", version: "0.0.1" },
    });

    await expect(removeBundledDependencyEdges(tarball)).rejects.toThrow(/@matrix-os\/missing/);
  });
});
