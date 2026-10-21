import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const location = 'location = /apps/browser-lab/viewer/websockify';
export function addViewerLocation(source) {
  if (source.includes(location)) return source;
  const matches = [...source.matchAll(/^([ \t]*)location \/apps\/ \{[ \t]*$/gm)];
  if (matches.length !== 1) throw new Error('Expected one existing app proxy');
  const [anchor, indent] = matches[0];
  const block = `${indent}${location} {\n${indent}  proxy_http_version 1.1;\n${indent}  proxy_set_header Upgrade $http_upgrade;\n${indent}  proxy_set_header Connection "upgrade";\n${indent}  proxy_read_timeout 600s;\n${indent}  proxy_pass http://127.0.0.1:4000;\n${indent}}\n\n`;
  return source.replace(anchor, block + anchor);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = '/etc/nginx/sites-available/matrix';
  const temporary = `${file}.browser-lab-tmp`;
  const source = await readFile(file, 'utf8');
  const updated = addViewerLocation(source);
  if (updated !== source) {
    try {
      await writeFile(temporary, updated, { flag: 'wx', mode: 0o644 });
      await rename(temporary, file);
      try { await promisify(execFile)('/usr/sbin/nginx', ['-t'], { timeout: 10_000, maxBuffer: 4096 }); }
      catch (error) {
        await writeFile(temporary, source, { flag: 'wx', mode: 0o644 });
        await rename(temporary, file);
        throw error;
      }
    } finally { await rm(temporary, { force: true }); }
  }
}
