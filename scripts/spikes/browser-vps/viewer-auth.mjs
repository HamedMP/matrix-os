import { readFile, writeFile, stat, chmod, chown, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function writeViewerAuthorization(path, authorization) {
  if (!/^Basic [A-Za-z0-9+/]+={0,2}$/.test(authorization)) throw new Error('Invalid stream credential');
  const metadata = await stat(path);
  const lines = (await readFile(path, 'utf8')).split('\n').filter(line => !line.startsWith('MATRIX_BROWSER_LAB_VIEWER_AUTH='));
  // Preview snapshots can omit the public shell origin. The lab's CSRF/WS
  // checks need the exact Matrix origin; preserve any explicit host setting.
  if (!lines.some(line => line.startsWith('SHELL_ORIGIN='))) lines.push('SHELL_ORIGIN=https://app.matrix-os.com');
  lines.push(`MATRIX_BROWSER_LAB_VIEWER_AUTH="${authorization}"`);
  const temporary = `${path}.browser-lab-tmp.${randomUUID()}`;
  try {
    await writeFile(temporary, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
    await chown(temporary, metadata.uid, metadata.gid);
    await chmod(temporary, metadata.mode & 0o777);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.getuid() !== 0) throw new Error('Root installer required');
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1024) throw new Error('Credential too large'); }
  await writeViewerAuthorization('/opt/matrix/env/host.env', input.trim());
}
