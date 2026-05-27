#!/usr/bin/env node
// One-shot generator for the apple-touch-icon and PWA maskable icon.
// Source: shell/src/app/icon.png (dark green-olive logo, transparent bg).
// Outputs:
//   shell/src/app/apple-icon.png  -- 180x180, opaque olive bg, warm-white logo,
//     bleeds to the edges so iOS rounded-corner masking looks clean.
//   shell/public/icon-maskable-512.png -- 512x512, same bg+logo recolor, logo
//     within inner 80% safe zone per W3C maskable spec.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname0 = dirname(fileURLToPath(import.meta.url));
const candidateRoots = [
  resolve(__dirname0, ".."),
  ...(process.env.MATRIX_REPO_ROOT ? [process.env.MATRIX_REPO_ROOT] : []),
];
let sharp;
for (const root of candidateRoots) {
  const pkgPath = resolve(root, "node_modules/sharp/package.json");
  if (existsSync(pkgPath)) {
    sharp = createRequire(pkgPath)("sharp");
    break;
  }
}
if (!sharp) {
  throw new Error(
    "sharp not installed in this worktree. Either `pnpm install` here, or set MATRIX_REPO_ROOT to a checkout that has it.",
  );
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SRC = resolve(ROOT, "shell/src/app/icon.png");
const OUT_APPLE = resolve(ROOT, "shell/src/app/apple-icon.png");
const OUT_MASK = resolve(ROOT, "shell/public/icon-maskable-512.png");

const BG = { r: 0x3f, g: 0x4a, b: 0x3a, alpha: 1 };
const FG = { r: 0xf4, g: 0xed, b: 0xe0, alpha: 1 };

async function tintedLogo(size) {
  const fgLayer = await sharp({
    create: { width: size, height: size, channels: 4, background: FG },
  })
    .png()
    .toBuffer();

  const fitted = await sharp(SRC)
    .resize({ width: size, height: size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  return sharp(fgLayer)
    .composite([{ input: fitted, blend: "dest-in" }])
    .png()
    .toBuffer();
}

async function compose({ outPath, size, innerSize, label }) {
  const inset = Math.round((size - innerSize) / 2);
  const logo = await tintedLogo(innerSize);
  await sharp({
    create: { width: size, height: size, channels: 4, background: BG },
  })
    .composite([{ input: logo, top: inset, left: inset }])
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  console.log(`${label}: ${outPath} (${size}x${size}, logo ${innerSize}x${innerSize})`);
}

await compose({ outPath: OUT_APPLE, size: 180, innerSize: 164, label: "apple-icon" });
await compose({ outPath: OUT_MASK, size: 512, innerSize: 410, label: "maskable" });
