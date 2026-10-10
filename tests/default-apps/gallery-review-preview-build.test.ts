import { afterEach, expect, it } from "vitest";
import { build } from "vite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
