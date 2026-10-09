// Keep first-paint CSS and the fresh-home template on the shared theme tokens.
import { readFileSync, writeFileSync } from 'node:fs';
import { getThemeChrome } from '../../packages/brand/src/themes';
import { buildWebTheme } from '../../packages/brand/src/themes/web-theme';
import { chromeToSemanticVars } from '../../desktop/src/renderer/src/design/themes/apply';
const path = 'desktop/src/renderer/src/design/tokens.css';
const [light, dark] = readFileSync(path, 'utf8').split('[data-theme="dark"]');
function update(css: string, mode: 'light' | 'dark') {
  const values = chromeToSemanticVars(getThemeChrome('matrix', mode));
  if (!css.includes('--sidebar:')) {
    const sidebar = Object.entries(values).filter(([key]) => key.startsWith('--sidebar')).map(([key, value]) => `${key}: ${value};`).join('\n  ');
    css = css.replace('--forest:', sidebar + '\n  --forest:');
  }
  return css.replace(/(--[\w-]+): [^;]+;/g, (line, key: string) => values[key] ? `${key}: ${values[key]};` : line);
}
writeFileSync(path, update(light!, 'light') + '[data-theme="dark"]' + update(dark!, 'dark'));
writeFileSync('home/system/theme.json', JSON.stringify(buildWebTheme(), null, 2) + '\n');
const webPath = 'shell/src/app/globals.css';
let css = readFileSync(webPath, 'utf8');
const start = css.indexOf(':root {');
const end = css.indexOf('\n}', start);
const defaults = buildWebTheme();
let block = css.slice(start, end);
for (const [key, value] of Object.entries(defaults.colors)) block = block.replace(new RegExp(`--${key}: [^;]+;`), `--${key}: ${value};`);
css = css.slice(0, start) + block + css.slice(end);
writeFileSync(webPath, css);
