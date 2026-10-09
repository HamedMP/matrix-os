// Repository builds refresh @matrix-os/brand tokens; installed apps retain the portable snapshot.
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
const tokens = new URL("../../../../packages/brand/src/tokens.ts", import.meta.url);
const snapshot = new URL("../src/styles/brand-tokens.css", import.meta.url);
const fonts = new URL("../public/fonts/", import.meta.url);
const names = ["geist-latin-wght-normal.woff2", "bricolage-grotesque-latin-wght-normal.woff2", "geist-OFL.txt", "bricolage-OFL.txt"];
const header = "/* Generated from @matrix-os/brand desktopPalette. Do not edit. */\n";
let repository = true;
try { await readFile(tokens); }
catch (error) {
  if (error?.code !== "ENOENT") throw error;
  repository = false;
}
if (repository) {
  const { desktopPalette } = await import(tokens.href);
  await writeFile(snapshot, header + ":root {\n" + Object.entries(desktopPalette).map(([key, value]) => `  --matrix-brand-${key}: ${value};`).join("\n") + "\n}\n");
  await mkdir(fonts, { recursive: true });
  for (const name of names) await copyFile(new URL(`../../../apps/_shared/fonts/${name}`, import.meta.url), new URL(name, fonts));
} else if (!(await readFile(snapshot, "utf8")).startsWith(header)) {
  throw new Error("Matrix brand snapshot unavailable");
}
// Missing shipped fonts must fail an owner rebuild instead of silently falling back.
await Promise.all(names.map(name => readFile(new URL(name, fonts))));
