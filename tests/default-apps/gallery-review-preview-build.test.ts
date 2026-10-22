import { afterEach, expect, it } from "vitest";
import { build } from "vite";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
it("builds all review entries and resolves the standalone shell alias after stack dependencies exist", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "matrix-gallery-review-build-")); temporaryRoots.push(temporary);
  const preview = resolve("specs/362-default-app-sculpted-family/preview");
  const aliasProbe = join(temporary, "shell-alias.ts");
  await writeFile(aliasProbe, 'import { CheckCircle2Icon } from "@/lib/hugeicons"; console.log(CheckCircle2Icon);');
  const output = join(temporary, "output");
  await build({ configFile: join(preview, "vite.config.ts"), logLevel: "error", build: { target: "esnext", outDir: output, rollupOptions: { input: {
    review: join(preview, "index.html"), auth: join(preview, "auth.html"), mobile: join(preview, "mobile.html"), aliasProbe,
  } } } });
  for (const name of ["index.html", "auth.html", "mobile.html"]) expect(await readFile(join(output, name), "utf8")).toContain("<html");
}, 60_000);

it("uses installed app light styles and artwork in the review fixture", async () => {
  const fixture = await readFile("specs/362-default-app-sculpted-family/preview/review.tsx", "utf8");
  expect(fixture).toContain('import("../../../home/app-templates/connected-starter/src/styles/gallery-light.css")');
  expect(fixture).toContain("iconDataUrl");
});


async function isolatedPreview() {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), "matrix-gallery-review-dependencies-"))); temporaryRoots.push(temporary);
  const preview = join(temporary, "specs/362-default-app-sculpted-family/preview");
  await mkdir(preview, { recursive: true });
  const modules = join(temporary, "shell/node_modules");
  await mkdir(join(modules, "@tailwindcss"), { recursive: true });
  await mkdir(join(modules, "@playwright"), { recursive: true });
  await writeFile(join(temporary, "shell/package.json"), '{"name":"preview-shell-dependencies","type":"module"}');
  for (const dependency of ["@tailwindcss/postcss", "@playwright/test", "tailwindcss"]) {
    await symlink(resolve("shell/node_modules", dependency), join(modules, dependency));
  }
  const source = resolve("specs/362-default-app-sculpted-family/preview");
  for (const file of ["postcss.config.mjs", "capture.mjs", "verify-responsive.mjs", "shell-require.mjs"]) {
    try { await cp(join(source, file), join(preview, file)); }
    catch (error) { if (file !== "shell-require.mjs" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  await mkdir(join(temporary, "home/system"), { recursive: true });
  await writeFile(join(temporary, "home/system/app-gallery.json"), '{"apps":[]}');
  return { temporary, preview };
}

it("loads preview PostCSS without root-hoisted shell dependencies", async () => {
  const { temporary, preview } = await isolatedPreview();
  await writeFile(join(preview, "index.html"), '<html><head><link rel="stylesheet" href="/probe.css"></head><body>Probe</body></html>');
  await writeFile(join(preview, "probe.css"), 'body { color: red; }');
  const configuration = { configFile: false, root: preview, logLevel: "error", css: { postcss: preview }, build: { outDir: join(temporary, "output") } };
  const probe = `const { build } = await import(${JSON.stringify(pathToFileURL(resolve("node_modules/vite/dist/node/index.js")).href)}); await build(${JSON.stringify(configuration)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { cwd: temporary, encoding: "utf8", timeout: 15_000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(await readFile(join(temporary, "output/index.html"), "utf8")).toContain("Probe");
});

it.each(["capture.mjs", "verify-responsive.mjs"])("resolves %s browser tooling through the declaring shell package", async script => {
  const { temporary, preview } = await isolatedPreview();
  const probe = `import { createRequire } from "node:module";
    const require = createRequire(${JSON.stringify(join(temporary, "shell/package.json"))});
    require("@playwright/test").chromium.launch = async () => { throw new Error("shell-owned-browser-probe"); };
    await import(${JSON.stringify(pathToFileURL(join(preview, script)).href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain("shell-owned-browser-probe");
  expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
});


it("builds the auth entry from tracked brand source without any brand dist output", async () => {
  const { temporary, preview } = await isolatedPreview();
  const source = resolve("specs/362-default-app-sculpted-family/preview");
  for (const file of ["vite.config.ts", "auth.html", "auth-review.tsx", "auth-review.css"]) {
    await cp(join(source, file), join(preview, file));
  }
  const brand = join(temporary, "packages/brand");
  await mkdir(brand, { recursive: true });
  await cp(resolve("packages/brand/package.json"), join(brand, "package.json"));
  await cp(resolve("packages/brand/src"), join(brand, "src"), { recursive: true });
  const auth = join(temporary, "shell/src/components/auth");
  await mkdir(auth, { recursive: true });
  await cp(resolve("shell/src/components/auth/ShellAuthLayout.tsx"), join(auth, "ShellAuthLayout.tsx"));
  await mkdir(join(temporary, "shell/src/app"), { recursive: true });
  await cp(resolve("shell/src/app/fonts.css"), join(temporary, "shell/src/app/fonts.css"));
  for (const scope of ["@fontsource", "@fontsource-variable"]) {
    await symlink(resolve("shell/node_modules", scope), join(temporary, "shell/node_modules", scope));
  }
  const modules = join(temporary, "node_modules");
  await mkdir(join(modules, "@matrix-os"), { recursive: true });
  await symlink(brand, join(modules, "@matrix-os/brand"));
  for (const dependency of ["react", "react-dom", "vite"]) {
    await symlink(resolve("node_modules", dependency), join(modules, dependency));
  }
  const output = join(temporary, "output");
  await build({ configFile: join(preview, "vite.config.ts"), logLevel: "error", build: { target: "esnext", outDir: output, rollupOptions: { input: join(preview, "auth.html") } } });
  expect(await readFile(join(output, "auth.html"), "utf8")).toContain("<html");
}, 60_000);
