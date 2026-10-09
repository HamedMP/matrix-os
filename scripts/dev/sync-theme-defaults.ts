// Keep first-paint CSS and the fresh-home template on shared theme values.
import { readFileSync, writeFileSync } from 'node:fs';
import { getThemeChrome } from '../../packages/brand/src/themes';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { chromeToSemanticVars } from '../../desktop/src/renderer/src/design/themes/apply';
const path = 'desktop/src/renderer/src/design/tokens.css';
const webPath = 'shell/src/app/theme-defaults.css';
const desktopCss = readFileSync(path, 'utf8');
const existing = readFileSync(webPath, 'utf8');
const uniqueMarker = (css: string, marker: string) => {
  const index = css.indexOf(marker);
  if (index < 0 || css.indexOf(marker, index + marker.length) >= 0) {
    throw new Error(`Expected exactly one stylesheet marker: ${marker}`);
  }
  return index;
};
const desktopDarkMarker = '[data-theme="dark"]';
const desktopDarkIndex = uniqueMarker(desktopCss, desktopDarkMarker);
const light = desktopCss.slice(0, desktopDarkIndex);
const dark = desktopCss.slice(desktopDarkIndex + desktopDarkMarker.length);
uniqueMarker(light, ':root {');
uniqueMarker(light, 'color-scheme:');
uniqueMarker(dark, 'color-scheme:');
const generatedIndex = uniqueMarker(existing, '/* Generated dark palette */');
const controlsIndex = uniqueMarker(existing, '/* Scope new control states');
const lightRootIndex = uniqueMarker(existing, ':root {');
const darkRootIndex = uniqueMarker(existing, '.dark, [data-theme="dark"] {');
if (!(lightRootIndex < generatedIndex && generatedIndex < darkRootIndex && darkRootIndex < controlsIndex)) {
  throw new Error('Theme stylesheet sections are out of order');
}
function update(css: string, mode: 'light' | 'dark') {
  const values = chromeToSemanticVars(getThemeChrome('matrix', mode));
  const missing = Object.entries(values).filter(([key]) => !css.includes(key + ':')).map(([key, value]) => `  ${key}: ${value};`).join('\n');
  css = css.replace(/(--[\w-]+): [^;]+;/g, (line, key: string) => values[key] ? `${key}: ${values[key]};` : line);
  return missing ? css.replace(/color-scheme:/, missing + '\n  color-scheme:') : css;
}
const desktopOutput = update(light, 'light') + desktopDarkMarker + update(dark, 'dark');
const homeOutput = JSON.stringify(buildWebTheme(), null, 2) + '\n';
const controls = existing.slice(controlsIndex);
let css = existing.slice(0, generatedIndex);
const defaults = buildWebTheme();
const missing = Object.entries(defaults.colors).filter(([key]) => !css.includes(`--${key}:`)).map(([key, value]) => `  --${key}: ${value};`).join('\n');
for (const [key, value] of Object.entries(defaults.colors)) css = css.replace(new RegExp(`--${key}: [^;]+;`), `--${key}: ${value};`);
css = css.replace('--radius: 0.75rem;', '--radius: 0.5rem;');
if (missing) css = css.replace(/\n}/, '\n' + missing + '\n}');
const darkColors = buildWebTheme({ ...defaults.appearance, mode: 'dark' }).colors;
css = css.trimEnd() + '\n';
css += '/* Generated dark palette */\n.dark, [data-theme="dark"] {\n' + Object.entries(darkColors).map(([key, value]) => `  --${key}: ${value};`).join('\n') + '\n}\n';
// Validate and generate every output before touching any target.
writeFileSync(path, desktopOutput);
writeFileSync('home/system/theme.json', homeOutput);
writeFileSync(webPath, css + controls);
