import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const desktop = join(root, "desktop");
const requireDesktop = createRequire(join(desktop, "package.json"));
const compiler = requireDesktop.resolve("electron-vite");
type BuildConfig = { define?: Record<string, string>; build?: { rollupOptions?: { external?: unknown } } };
let config: { main?: BuildConfig; preload?: BuildConfig };
let sourceFixture: string;
let fixtureConfig: string;
let sourceCommit: string;

function isolatedGitEnv(ambient: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Fixture Git commands must not target a caller's repository or inherit
  // signing, hooks or templates from the developer/CI machine.
  return { ...Object.fromEntries(Object.entries(ambient).filter(([name]) => !name.startsWith("GIT_"))),
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function fixtureGit(...args: string[]) {
  return execFileSync("git", args, { cwd: sourceFixture, env: isolatedGitEnv(),
    encoding: "utf8", timeout: 10_000, stdio: "pipe" }).trim();
}

function loadFixtureConfig(ambient: NodeJS.ProcessEnv = process.env) {
  // Supply the fixture's SHA only to the child, retaining the unit runner's
  // environment and the production config's strict provenance checks.
  return execFileSync(process.execPath, ["--input-type=module", "-e", `
    const api = await import(${JSON.stringify(pathToFileURL(compiler).href)});
    const { config } = await api.loadConfigFromFile(
      { command: "build", mode: "production" }, ${JSON.stringify(fixtureConfig)},
      ${JSON.stringify(join(sourceFixture, "desktop"))}, "silent", true,
    );
    console.log(JSON.stringify(config));
  `], { cwd: sourceFixture, env: { ...isolatedGitEnv(ambient), GITHUB_SHA: sourceCommit },
    encoding: "utf8", timeout: 20_000, maxBuffer: 1024 * 1024, stdio: "pipe" });
}

beforeAll(() => {
  sourceFixture = mkdtempSync(join(tmpdir(), "matrix-electron-config-source-"));
  for (const path of ["desktop/electron.vite.config.ts", "desktop/src/main/renderer-url.ts",
    "desktop/package.json", "scripts/release/build-source.mjs"]) {
    const target = join(sourceFixture, path);
    mkdirSync(resolve(target, ".."), { recursive: true });
    copyFileSync(join(root, path), target);
  }
  writeFileSync(join(sourceFixture, "package.json"), '{"type":"module"}\n');
  writeFileSync(join(sourceFixture, ".gitignore"), "node_modules/\n");
  for (const directory of ["", "desktop"]) {
    symlinkSync(join(root, directory, "node_modules"), join(sourceFixture, directory, "node_modules"), "dir");
  }
  fixtureGit("init", "--template=", "-b", "main");
  fixtureGit("add", ".");
  fixtureGit("-c", "user.name=Config fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "test: actual production config");
  sourceCommit = fixtureGit("rev-parse", "HEAD");
  fixtureConfig = join(sourceFixture, "desktop/electron.vite.config.ts");
  config = JSON.parse(loadFixtureConfig());
});
afterAll(() => {
  if (sourceFixture) rmSync(sourceFixture, { recursive: true, force: true });
});

describe("Rolldown Electron builtin boundary", () => {
  it("loads the actual production config with matching strict source provenance", () => {
    expect(JSON.parse(config.main!.define!.__MATRIX_DESKTOP_BUILD_SOURCE__).commit).toBe(sourceCommit);
    expect(fixtureGit("status", "--porcelain")).toBe("");
  });

  it("isolates an inherited release SHA in the child without changing the parent environment", () => {
    const parentReleaseSha = process.env.GITHUB_SHA;
    const isolated = JSON.parse(loadFixtureConfig({ ...process.env, GITHUB_SHA: "f".repeat(40) }));
    expect(JSON.parse(isolated.main.define.__MATRIX_DESKTOP_BUILD_SOURCE__).commit).toBe(sourceCommit);
    expect(process.env.GITHUB_SHA).toBe(parentReleaseSha);
    expect(fixtureGit("status", "--porcelain")).toBe("");
  });

  it("isolates the real config from hostile ambient Git repository and signing configuration", () => {
    const hostileConfig = join(sourceFixture, ".git", "hostile-global-config");
    writeFileSync(hostileConfig, "[commit]\n  gpgSign = true\n[core]\n  hooksPath = /missing-fixture-hooks\n");
    try {
      const isolated = JSON.parse(loadFixtureConfig({ ...process.env,
        GIT_DIR: join(sourceFixture, "missing-repository"), GIT_WORK_TREE: root,
        GIT_INDEX_FILE: join(sourceFixture, "missing-index"), GIT_CONFIG_GLOBAL: hostileConfig,
        GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: root,
      }));
      expect(JSON.parse(isolated.main.define.__MATRIX_DESKTOP_BUILD_SOURCE__).commit).toBe(sourceCommit);
      expect(fixtureGit("status", "--porcelain")).toBe("");
    } finally { rmSync(hostileConfig); }
  });

  it("still rejects untracked source in the committed config fixture", () => {
    const path = join(sourceFixture, "unreviewed-source.ts");
    writeFileSync(path, "export const unreviewed = true;\n");
    try {
      expect(() => loadFixtureConfig()).toThrow(/Release checkout has uncommitted source changes/);
    } finally {
      rmSync(path);
    }
  });

  it("pins the temporary Desktop migration bridge without replacing unit-test Vite", () => {
    const desktopPackage = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));
    const rootPackage = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(desktopPackage.devDependencies.vite).toBe("npm:rolldown-vite@7.3.1");
    expect(rootPackage.pnpm.overrides["electron-vite>vite"]).toBe("npm:rolldown-vite@7.3.1");
    expect(rootPackage.pnpm.overrides.vite).toBeUndefined();
  });

  it.each(["main", "preload"] as const)("keeps Electron explicitly external in %s", (entry) => {
    expect(config[entry]?.build?.rollupOptions?.external).toContain("electron");
  });

  it("emits native Electron imports instead of bundling its npm installer", () => {
    const fixture = mkdtempSync(join(tmpdir(), "matrix-electron-builtins-"));
    try {
      // Config bundling resolves declared Desktop dependencies from this private
      // fixture; neither its source nor build output touches the checkout.
      symlinkSync(join(desktop, "node_modules"), join(fixture, "node_modules"), "dir");
      writeFileSync(join(fixture, "package.json"), '{"type":"module"}\n');
      writeFileSync(join(fixture, "main.ts"), 'import { app } from "electron"; console.log(app.name);\n');
      writeFileSync(join(fixture, "preload.ts"), 'import { contextBridge } from "electron"; contextBridge.exposeInMainWorld("fixture", { ready: true });\n');
      writeFileSync(join(fixture, "config.mjs"), `
        import original from ${JSON.stringify(fixtureConfig)};
        // Defer provenance evaluation until electron-vite removes its bundled
        // config from the checkout, just like the production config callback.
        export default () => {
          const base = original();
          return {
          main: { ...base.main, build: { ...base.main.build, outDir: ${JSON.stringify(join(fixture, "main"))},
            rollupOptions: { ...base.main.build.rollupOptions, input: { index: ${JSON.stringify(join(fixture, "main.ts"))} } } } },
          preload: { ...base.preload, build: { ...base.preload.build, outDir: ${JSON.stringify(join(fixture, "preload"))},
            rollupOptions: { ...base.preload.build.rollupOptions, input: ${JSON.stringify(join(fixture, "preload.ts"))} } } },
          };
        };
      `);
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { build } = await import(${JSON.stringify(pathToFileURL(compiler).href)});
        await build({ configFile: ${JSON.stringify(join(fixture, "config.mjs"))}, ignoreConfigWarning: true });
      `], { cwd: desktop, env: { ...isolatedGitEnv(), GITHUB_SHA: sourceCommit }, timeout: 20_000, maxBuffer: 1024 * 1024, stdio: "pipe" });
      const main = readFileSync(join(fixture, "main/index.js"), "utf8");
      const preload = readFileSync(join(fixture, "preload/index.cjs"), "utf8");
      expect(main).toMatch(/from ["']electron["']/);
      expect(preload).toMatch(/require\(["']electron["']\)/);
      for (const output of [main, preload]) {
        expect(output).not.toContain("Electron failed to install correctly");
        expect(output).not.toContain("getElectronPath");
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 30_000);
});
