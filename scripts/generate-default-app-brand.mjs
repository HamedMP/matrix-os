#!/usr/bin/env node
import { desktopPalette } from '../packages/brand/src/tokens.ts';
import { readFile, writeFile } from 'node:fs/promises';

const palette = Object.entries(desktopPalette).map(([key, value]) => `  --matrix-brand-${key}: ${value};`).join('\n');
const template = await readFile(new URL('../home/apps/_shared/matrix-brand.template.css', import.meta.url), 'utf8');
await writeFile(new URL('../home/apps/_shared/matrix-brand.css', import.meta.url), template.replace('/* BRAND_TOKENS */', palette));
