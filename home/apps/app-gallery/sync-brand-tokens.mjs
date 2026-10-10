// Keep owner copies portable; repository builds refresh the canonical brand snapshot.
import { readFile, writeFile } from 'node:fs/promises';
const canonical = new URL('../../../packages/brand/src/tokens.ts', import.meta.url);
const output = new URL('./src/brand-tokens.css', import.meta.url);
const header = '/* Generated from @matrix-os/brand. Run sync-brand-tokens.mjs; do not edit. */\n';
let source;
try { source = await readFile(canonical, 'utf8'); }
catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  const snapshot = await readFile(output, 'utf8');
  if (!snapshot.startsWith(header)) throw new Error('Gallery brand snapshot unavailable');
}
if (source !== undefined) {
  const { palette, desktopPalette: p, desktopFonts: f, appGalleryPalette: g } = await import(canonical.href);
  const values = {
    forest: p.forest, paper: p.paper, canvas: p.canvas, muted: p.surfaceMuted,
    border: palette.border, ink: palette.brandInk, 'muted-fg': p.textMuted,
    green: p.green, gold: p.gold, coral: p.coral, danger: p.danger,
    'font-display': f.display, 'font-sans': f.sans,
    ...Object.fromEntries(Object.entries(g).map(([key,value]) => [`gallery-${key}`, value])),
  };
  await writeFile(output, header + ':root {\n' + Object.entries(values).map(([key,value]) => `  --brand-${key}: ${value};`).join('\n') + '\n}\n');
}
