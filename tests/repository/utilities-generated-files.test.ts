import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reconcileGeneratedFiles, sha256, verifySnapshot } from "../../scripts/utility-toolkit-snapshot.mjs";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "utilities-generated-"));
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}
async function put(root: string, path: string, value = "source") {
  const absolute = join(root, path);
  await mkdir(join(absolute, ".."), { recursive: true });
  await writeFile(absolute, value);
}

describe("Utilities generated-file reconciliation", () => {
  it("verification rejects a deleted engine left outside the new manifest", async () => {
    await fixture(async (root) => {
      await put(root, "src/vendor/lib/current.mjs");
      await put(root, "src/vendor/lib/deleted.mjs");
      const files = [{ path: "src/vendor/lib/current.mjs", sha256: sha256("source") }];
      expect(await verifySnapshot(root, { files })).toEqual(["src/vendor/lib/deleted.mjs"]);
    });
  });
  it("sync removes obsolete engines and model assets while preserving owned app files", async () => {
    await fixture(async (root) => {
      await put(root, "src/vendor/lib/current.mjs");
      await put(root, "src/vendor/workspaces/Deleted.tsx");
      await put(root, "public/tools/models/obsolete.bin");
      await put(root, "src/App.tsx", "owned");
      await reconcileGeneratedFiles(root, ["src/vendor/lib/current.mjs"]);
      expect(await readFile(join(root, "src/App.tsx"), "utf8")).toBe("owned");
      expect(await readFile(join(root, "src/vendor/lib/current.mjs"), "utf8")).toBe("source");
      await expect(stat(join(root, "src/vendor/workspaces/Deleted.tsx"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "public/tools/models"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await verifySnapshot(root, { files: [{ path: "src/vendor/lib/current.mjs", sha256: sha256("source") }] })).toEqual([]);
    });
  });
  it("repeated CLI imports remove deleted sources and old assets", async () => {
    await fixture(async (root) => {
      const site = join(root, "site"), app = join(root, "home/apps/utilities");
      await put(site, "src/lib/free-tools/tool-icons.mjs", 'export const toolIconSvg = () => "<svg/>";');
      await put(site, "src/lib/free-tools/obsolete.mjs", "export const obsolete = true;");
      await mkdir(join(site, "src/app/tools"), { recursive: true });
      await mkdir(join(root, "scripts"), { recursive: true });
      for (const script of ["sync-utilities-toolkit.mjs", "utility-toolkit-snapshot.mjs"]) {
        await cp(new URL(`../../scripts/${script}`, import.meta.url), join(root, "scripts", script));
      }
      const git = (...args: string[]) => execFileSync("git", ["-C", site, ...args], { encoding: "utf8" }).trim();
      const commit = () => {
        git("add", "--all");
        git("-c", "user.name=Utilities test", "-c", "user.email=utilities@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
      };
      const sync = () => execFileSync(process.execPath, [join(root, "scripts/sync-utilities-toolkit.mjs"), site]);
      git("init", "--quiet"); commit(); sync();
      await put(app, "public/tools/models/old.bin");
      await put(app, "src/App.tsx", "owned");
      await rm(join(site, "src/lib/free-tools/obsolete.mjs"));
      await put(site, "src/lib/free-tools/current.mjs", "export const current = true;");
      commit(); sync();
      await expect(stat(join(app, "src/vendor/lib/obsolete.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(app, "public/tools/models/old.bin"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(app, "src/App.tsx"), "utf8")).toBe("owned");
      expect(await readFile(join(app, "src/vendor/lib/current.mjs"), "utf8")).toContain("current = true");
      const manifest = JSON.parse(await readFile(join(app, "toolkit-source.json"), "utf8"));
      expect(await verifySnapshot(app, manifest)).toEqual([]);
    });
  });
  it("never follows generated-tree symlinks or deletes their external target", async () => {
    await fixture(async (root) => {
      await put(root, "external/keep.mjs", "keep");
      await mkdir(join(root, "src/vendor"), { recursive: true });
      await symlink(join(root, "external"), join(root, "src/vendor/lib"));
      await expect(reconcileGeneratedFiles(root, [])).rejects.toThrow(/symlink/i);
      await expect(verifySnapshot(root, { files: [] })).rejects.toThrow(/symlink/i);
      expect(await readFile(join(root, "external/keep.mjs"), "utf8")).toBe("keep");
    });
  });
  it("rejects unsafe cleanup paths before removing generated files", async () => {
    await fixture(async (root) => {
      await put(root, "src/vendor/lib/current.mjs");
      await expect(reconcileGeneratedFiles(root, ["../outside"])).rejects.toThrow(/invalid/i);
      expect(await readFile(join(root, "src/vendor/lib/current.mjs"), "utf8")).toBe("source");
    });
  });
});
