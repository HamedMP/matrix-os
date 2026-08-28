#!/usr/bin/env node

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopFonts,
  lightFg,
  palette as brandPalette,
} from "../packages/brand/src/tokens.ts";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDirectory, "..");
const candidateRoots = [
  root,
  ...(process.env.MATRIX_REPO_ROOT ? [process.env.MATRIX_REPO_ROOT] : []),
];

let sharp;
let dependencyRoot;
for (const candidateRoot of candidateRoots) {
  const packagePath = resolve(candidateRoot, "node_modules/sharp/package.json");
  const fontRoot = resolve(
    candidateRoot,
    "node_modules/@expo-google-fonts/bricolage-grotesque",
  );
  const fontPaths = [
    resolve(fontRoot, "400Regular/BricolageGrotesque_400Regular.ttf"),
    resolve(fontRoot, "600SemiBold/BricolageGrotesque_600SemiBold.ttf"),
    resolve(fontRoot, "700Bold/BricolageGrotesque_700Bold.ttf"),
  ];
  if (existsSync(packagePath) && fontPaths.every(existsSync)) {
    sharp = createRequire(packagePath)("sharp");
    dependencyRoot = candidateRoot;
    break;
  }
}

if (!sharp || !dependencyRoot) {
  throw new Error(
    "The DMG generator dependencies are not installed in this worktree. Run `pnpm install`, or set MATRIX_REPO_ROOT to a checkout that has both sharp and Bricolage Grotesque installed.",
  );
}

const palette = {
  forest: brandPalette.forest,
  forestDeep: brandPalette.forestDeep,
  cream: brandPalette.cream,
  light: lightFg,
  ember: brandPalette.ember,
};

const width = 720;
const height = 520;
const logoPath = resolve(root, "desktop/src/renderer/src/assets/matrix-logo.svg");
const displayFontDirectory = resolve(
  dependencyRoot,
  "node_modules/@expo-google-fonts/bricolage-grotesque",
);
const displayFontRegularPath = resolve(
  displayFontDirectory,
  "400Regular/BricolageGrotesque_400Regular.ttf",
);
const displayFontSemiBoldPath = resolve(
  displayFontDirectory,
  "600SemiBold/BricolageGrotesque_600SemiBold.ttf",
);
const displayFontBoldPath = resolve(
  displayFontDirectory,
  "700Bold/BricolageGrotesque_700Bold.ttf",
);
const outputPath = resolve(root, "desktop/build/dmg-background.png");
const outputRetinaPath = resolve(root, "desktop/build/dmg-background@2x.png");

for (const assetPath of [
  logoPath,
  displayFontRegularPath,
  displayFontSemiBoldPath,
  displayFontBoldPath,
]) {
  if (!existsSync(assetPath)) {
    throw new Error(`Required Matrix brand asset is missing: ${assetPath}`);
  }
}

const [displayFontRegular, displayFontSemiBold, displayFontBold] = await Promise.all([
  readFile(displayFontRegularPath),
  readFile(displayFontSemiBoldPath),
  readFile(displayFontBoldPath),
]);

const displayFontFamily = desktopFonts.display;

function backgroundSvg() {
  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="background" x1="36" y1="12" x2="690" y2="508" gradientUnits="userSpaceOnUse">
          <stop offset="0" stop-color="${palette.forest}"/>
          <stop offset="0.55" stop-color="#374233"/>
          <stop offset="1" stop-color="${palette.forestDeep}"/>
        </linearGradient>
        <radialGradient id="topGlow" cx="0" cy="0" r="1" gradientTransform="translate(360 15) rotate(90) scale(300 470)" gradientUnits="userSpaceOnUse">
          <stop stop-color="${palette.light}" stop-opacity="0.10"/>
          <stop offset="1" stop-color="${palette.light}" stop-opacity="0"/>
        </radialGradient>
        <radialGradient id="emberGlow" cx="0" cy="0" r="1" gradientTransform="translate(360 322) rotate(90) scale(128 210)" gradientUnits="userSpaceOnUse">
          <stop stop-color="${palette.ember}" stop-opacity="0.08"/>
          <stop offset="1" stop-color="${palette.ember}" stop-opacity="0"/>
        </radialGradient>
        <filter id="softShadow" x="-40%" y="-40%" width="180%" height="180%">
          <feGaussianBlur stdDeviation="7"/>
        </filter>
        <style>
          @font-face {
            font-family: "Bricolage Grotesque";
            src: url("data:font/ttf;base64,${displayFontRegular.toString("base64")}") format("truetype");
            font-weight: 400;
          }
          @font-face {
            font-family: "Bricolage Grotesque";
            src: url("data:font/ttf;base64,${displayFontSemiBold.toString("base64")}") format("truetype");
            font-weight: 600;
          }
          @font-face {
            font-family: "Bricolage Grotesque";
            src: url("data:font/ttf;base64,${displayFontBold.toString("base64")}") format("truetype");
            font-weight: 700;
          }
          .display { font-family: ${displayFontFamily}; }
        </style>
      </defs>

      <rect width="${width}" height="${height}" fill="url(#background)"/>
      <rect width="${width}" height="${height}" fill="url(#topGlow)"/>
      <rect width="${width}" height="${height}" fill="url(#emberGlow)"/>
      <rect x="0.5" y="0.5" width="719" height="519" rx="1" fill="none" stroke="${palette.light}" stroke-opacity="0.08"/>

      <text class="display" x="360" y="105" fill="${palette.light}" font-size="42" font-weight="700" text-anchor="middle" letter-spacing="-1.2">Install Matrix OS</text>
      <text class="display" x="360" y="140" fill="${palette.cream}" fill-opacity="0.78" font-size="17" font-weight="400" text-anchor="middle">Drag Matrix OS to Applications</text>

      <circle cx="190" cy="322" r="78" fill="${palette.light}" fill-opacity="0.018" stroke="${palette.light}" stroke-opacity="0.045"/>
      <circle cx="530" cy="322" r="78" fill="${palette.light}" fill-opacity="0.018" stroke="${palette.light}" stroke-opacity="0.045"/>

      <path d="M301 322H419" stroke="#10140F" stroke-opacity="0.22" stroke-width="12" stroke-linecap="round" filter="url(#softShadow)"/>
      <path d="M301 322H414" stroke="${palette.ember}" stroke-width="5" stroke-linecap="round"/>
      <path d="M396 303L415 322L396 341" fill="none" stroke="${palette.ember}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>

      <text class="display" x="360" y="472" fill="${palette.cream}" fill-opacity="0.46" font-size="12" font-weight="600" text-anchor="middle" letter-spacing="1.4">YOUR PRIVATE AI COMPUTER</text>
    </svg>
  `;
}

function rgba(hex, alpha) {
  const value = hex.slice(1);
  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
    alpha,
  };
}

async function tintedLogo({ logoHeight, color, opacity }) {
  const logoWidth = Math.round((logoHeight * 510) / 660);
  const mask = await sharp(logoPath)
    .resize({ width: logoWidth, height: logoHeight, fit: "contain" })
    .png()
    .toBuffer();
  const foreground = await sharp({
    create: {
      width: logoWidth,
      height: logoHeight,
      channels: 4,
      background: rgba(color, opacity),
    },
  })
    .png()
    .toBuffer();

  return {
    input: await sharp(foreground)
      .composite([{ input: mask, blend: "dest-in" }])
      .png()
      .toBuffer(),
    width: logoWidth,
  };
}

async function render(scale, target) {
  const outputWidth = width * scale;
  const outputHeight = height * scale;
  const [brandLogo, ambientLeft, ambientRight] = await Promise.all([
    tintedLogo({ logoHeight: 30 * scale, color: palette.cream, opacity: 1 }),
    tintedLogo({ logoHeight: 300 * scale, color: palette.cream, opacity: 0.032 }),
    tintedLogo({ logoHeight: 350 * scale, color: palette.cream, opacity: 0.026 }),
  ]);

  const base = await sharp(Buffer.from(backgroundSvg()), { density: 72 * scale })
    .resize({ width: outputWidth, height: outputHeight, fit: "fill" })
    .png()
    .toBuffer();

  await sharp(base)
    .composite([
      { input: ambientLeft.input, left: -64 * scale, top: 190 * scale },
      { input: ambientRight.input, left: 582 * scale, top: 226 * scale },
      {
        input: brandLogo.input,
        left: Math.round((outputWidth - brandLogo.width) / 2),
        top: 28 * scale,
      },
    ])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toFile(target);

  console.log(`desktop DMG background: ${target} (${outputWidth}x${outputHeight})`);
}

await render(1, outputPath);
await render(2, outputRetinaPath);
