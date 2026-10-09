// Keep first-paint CSS and the fresh-home template on shared theme values.
import { readFileSync, writeFileSync } from 'node:fs';
import { getThemeChrome } from '../../packages/brand/src/themes';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { chromeToSemanticVars } from '../../desktop/src/renderer/src/design/themes/apply';
const path = 'desktop/src/renderer/src/design/tokens.css';
const [light, dark] = readFileSync(path, 'utf8').split('[data-theme="dark"]');
function update(css: string, mode: 'light' | 'dark') {
  const values = chromeToSemanticVars(getThemeChrome('matrix', mode));
  const missing = Object.entries(values).filter(([key]) => !css.includes(key + ':')).map(([key, value]) => `  ${key}: ${value};`).join('\n');
  css = css.replace(/(--[\w-]+): [^;]+;/g, (line, key: string) => values[key] ? `${key}: ${values[key]};` : line);
  return missing ? css.replace(/color-scheme:/, missing + '\n  color-scheme:') : css;
}
writeFileSync(path, update(light!, 'light') + '[data-theme="dark"]' + update(dark!, 'dark'));
writeFileSync('home/system/theme.json', JSON.stringify(buildWebTheme(), null, 2) + '\n');
const webPath = 'shell/src/app/theme-defaults.css';
const existing = readFileSync(webPath, 'utf8');
const controls = existing.slice(existing.indexOf('/* Scope new control states'));
let css = existing.split('/* Generated dark palette */')[0]!;
const defaults = buildWebTheme();
const missing = Object.entries(defaults.colors).filter(([key]) => !css.includes(`--${key}:`)).map(([key, value]) => `  --${key}: ${value};`).join('\n');
for (const [key, value] of Object.entries(defaults.colors)) css = css.replace(new RegExp(`--${key}: [^;]+;`), `--${key}: ${value};`);
css = css.replace('--radius: 0.75rem;', '--radius: 0.5rem;');
if (missing) css = css.replace(/\n}/, '\n' + missing + '\n}');
const darkColors = buildWebTheme({ ...defaults.appearance, mode: 'dark' }).colors;
css = css.trimEnd() + '\n';
css += '/* Generated dark palette */\n.dark, [data-theme="dark"] {\n' + Object.entries(darkColors).map(([key, value]) => `  --${key}: ${value};`).join('\n') + '\n}\n';
writeFileSync(webPath, css + controls);

