import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const desktop = join(root, "desktop");
const requireDesktop = createRequire(join(desktop, "package.json"));
const compiler = requireDesktop.resolve("electron-vite");
const configPath = join(desktop, "electron.vite.config.ts");
type BuildConfig = { build?: { rollupOptions?: { external?: unknown } } };
let config: { main?: BuildConfig; preload?: BuildConfig };

beforeAll(async () => {
  const api = await import(pathToFileURL(compiler).href);
  ({ config } = await api.loadConfigFromFile(
    { command: "build", mode: "production" }, configPath, desktop, "silent", true,
  ));
});

describe("Rolldown Electron builtin boundary", () => {
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
        import original from ${JSON.stringify(configPath)};
        const base = original();
        export default {
          main: { ...base.main, build: { ...base.main.build, outDir: ${JSON.stringify(join(fixture, "main"))},
            rollupOptions: { ...base.main.build.rollupOptions, input: { index: ${JSON.stringify(join(fixture, "main.ts"))} } } } },
          preload: { ...base.preload, build: { ...base.preload.build, outDir: ${JSON.stringify(join(fixture, "preload"))},
            rollupOptions: { ...base.preload.build.rollupOptions, input: ${JSON.stringify(join(fixture, "preload.ts"))} } } },
        };
      `);
      execFileSync(process.execPath, ["--input-type=module", "-e", `
        const { build } = await import(${JSON.stringify(pathToFileURL(compiler).href)});
        await build({ configFile: ${JSON.stringify(join(fixture, "config.mjs"))}, ignoreConfigWarning: true });
      `], { cwd: desktop, timeout: 20_000, maxBuffer: 1024 * 1024, stdio: "pipe" });
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
