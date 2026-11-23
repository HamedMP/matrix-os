import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, request } from 'node:http';
import { parse } from 'yaml';
import { APP_FILE_MAX_BYTES, MAX_APP_FILE_REQUEST_BYTES } from '../../packages/contracts/src/app-files';

const helper = resolve('distro/customer-vps/host-bin/matrix-configure-sites-nginx');
// The production-host integration cases require its nginx binary; generic CI
// images still run the independent installer and symlink boundary contracts.
const nginxIt = existsSync('/usr/sbin/nginx') ? it : it.skip;
const owned: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
 for (const child of children.splice(0)) { child.kill('SIGTERM'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve)); }
 for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'mngx-')); owned.push(root);
 await mkdir(join(root, 'etc/nginx/sites-available'), { recursive: true });
 return root;
}
async function provisioned() {
 const cloud = parse(await readFile('distro/customer-vps/cloud-init.yaml', 'utf8'));
 return cloud.write_files.find((f: { path: string }) => f.path === '/etc/nginx/sites-available/matrix').content as string;
}
function localize(text: string, root: string) {
 return text.replace(/^\s*listen 443[^;]*;/gm, line => `listen unix:${root}/front.sock${line.includes('default_server') ? ' default_server' : ''};`)
  .replace(/^\s*ssl_certificate(?:_key)?[^;]*;/gm, '');
}
async function configuration(root: string, server: string) {
 await writeFile(join(root, 'etc/nginx/sites-available/matrix'), server);
 await writeFile(join(root, 'etc/nginx/nginx.conf'), `pid ${root}/nginx.pid; error_log ${root}/error.log; events { worker_connections 32; } http { access_log off; client_body_temp_path ${root}/body; proxy_temp_path ${root}/proxy; proxy_read_timeout 80ms; include ${root}/etc/nginx/sites-available/matrix; }`);
}
function migrate(root: string) { return execFileSync('/usr/bin/python3', ['-I', helper, '--root', root], { encoding: 'utf8', timeout: 15000 }); }
async function waitForSocket(path: string, child: ChildProcess) {
 for (let n = 0; n < 100; n++) {
  try { if ((await stat(path)).isSocket()) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (child.exitCode !== null) throw Error('nginx exited before listening');
  await new Promise(resolve => setTimeout(resolve, 10));
 }
 throw Error('nginx startup deadline');
}
async function exchange(root: string, path: string) {
 return new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ socketPath: join(root, 'front.sock'), path, method: 'POST', headers: { host: 'preview.example' }, timeout: 2000 }, res => {
   let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; if (body.length > 8192) req.destroy(Error('response bound')); });
   res.on('end', () => resolve({ status: res.statusCode!, body }));
  });
  req.on('timeout', () => req.destroy(Error('request deadline'))); req.on('error', reject); req.end();
 });
}
nginxIt('allows slow publishes through the actual provisioned nginx while other API paths keep their timeout', async () => {
 const root = await fixture();
 const upstream = createServer((req, res) => { const timer = setTimeout(() => res.end('published'), 250); res.once('close', () => clearTimeout(timer)); });
 await new Promise<void>(resolve => upstream.listen(join(root, 'up.sock'), resolve));
 try {
  const config = localize(await provisioned(), root).replaceAll('http://127.0.0.1:4000', `http://unix:${root}/up.sock:`).replaceAll('300s', '600ms');
  await configuration(root, config);
  const child = spawn('/usr/sbin/nginx', ['-p', root, '-c', join(root, 'etc/nginx/nginx.conf'), '-g', 'daemon off; master_process off;'], { stdio: 'ignore' }); children.push(child);
  await waitForSocket(join(root, 'front.sock'), child);
  expect((await exchange(root, '/api/apps/launch/site')).status).toBe(200);
  expect((await exchange(root, '/api/other')).status).toBe(504);
  expect((await exchange(root, '/api/apps/launch/site/extra')).status).toBe(504);
 } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
nginxIt('updates an existing VPS atomically, preserves API authentication and is idempotent', async () => {
 const root = await fixture();
 const original = `server { listen unix:${root}/front.sock; server_name _;\n  location /api/ {\n    proxy_set_header Authorization "Bearer fixture-only";\n    proxy_pass http://127.0.0.1:4000;\n  }\n}\n`;
 await configuration(root, original); migrate(root);
 const path = join(root, 'etc/nginx/sites-available/matrix'), changed = await readFile(path, 'utf8');
 expect(changed).toContain('proxy_read_timeout 300s;');
 // The publishing, speech and app file locations each clone the API authentication.
 expect(changed.match(/proxy_set_header Authorization "Bearer fixture-only";/g)).toHaveLength(4);
 expect(changed).toContain(original.slice(original.indexOf('  location /api/')));
 migrate(root); expect(await readFile(path, 'utf8')).toBe(changed);
 const prerequisites = await readFile('distro/customer-vps/host-bin/matrix-prepare-host-prerequisites', 'utf8');
 expect(prerequisites).toContain('matrix-configure-sites-nginx');
});
nginxIt('restores the original existing-VPS configuration when nginx validation fails', async () => {
 const root = await fixture();
 const original = `server { listen unix:${root}/front.sock;\n  location /api/ {\n    proxy_pass http://127.0.0.1:4000;\n  }\n}\n`;
 await configuration(root, original); await writeFile(join(root, 'etc/nginx/nginx.conf'), 'invalid_nginx_config;');
 expect(() => migrate(root)).toThrow('Matrix Sites nginx update failed');
 expect(await readFile(join(root, 'etc/nginx/sites-available/matrix'), 'utf8')).toBe(original);
});
it('rejects a managed-config symlink without modifying its target', async () => {
 const root = await fixture(), outside = join(root, 'owner-config'); await writeFile(outside, 'preserve owner content');
 await symlink(outside, join(root, 'etc/nginx/sites-available/matrix'));
 expect(() => migrate(root)).toThrow('Matrix Sites nginx update failed'); expect(await readFile(outside, 'utf8')).toBe('preserve owner content');
});
it('gives self-hosted publishing the same timeout and preserves its bearer include', async () => {
 const installer = await readFile('scripts/install-server.sh', 'utf8');
 const publish = installer.match(/location ~ "\^\/api\/apps\/[^\n]+\/site\\\$" \{([\s\S]*?)\n  \}/)?.[1];
 expect(publish).toContain('proxy_read_timeout 300s;');
 expect(publish).toContain('include /opt/matrix/env/gateway-auth-token.conf;');
});
async function upload(root: string, path: string, bytes: number) {
 return new Promise<number>((resolve, reject) => {
  const req = request({ socketPath: join(root, 'front.sock'), path, method: 'POST', timeout: 10000,
   headers: { host: 'preview.example', 'content-length': bytes, 'content-type': 'application/octet-stream' } }, res => {
   res.resume(); res.on('end', () => resolve(res.statusCode!));
  });
  req.on('timeout', () => req.destroy(Error('request deadline'))); req.on('error', reject); req.end(Buffer.alloc(bytes));
 });
}
nginxIt('lets an existing VPS accept a ten-minute dictation upload while other API paths keep the 10 MB limit', async () => {
 // Fault: nginx answered 413 for any recording over 10 MB (about five and a half
 // minutes of 16 kHz PCM16) before the gateway saw it.
 const root = await fixture();
 const upstream = createServer((req, res) => { req.resume(); req.on('end', () => res.end('transcribed')); });
 await new Promise<void>(resolve => upstream.listen(join(root, 'up.sock'), resolve));
 try {
  const original = `server { listen unix:${root}/front.sock; server_name _;\n  client_max_body_size 10m;\n  location /api/ {\n    proxy_pass http://unix:${root}/up.sock:;\n  }\n}\n`;
  // The helper only recognises the production upstream, so migrate first and localize after.
  await configuration(root, original.replace(`http://unix:${root}/up.sock:`, 'http://127.0.0.1:4000')); migrate(root);
  const path = join(root, 'etc/nginx/sites-available/matrix'), migrated = await readFile(path, 'utf8');
  expect(migrated).toContain('# matrix-speech-upload-limit-v1\n  location = /api/speech/transcriptions {\n    client_max_body_size 21m;\n    proxy_read_timeout 90s;');
  // The publishing block must stay directly above the API location: helpers
  // from earlier bundles verify exactly that after a rollback.
  expect(migrated).toContain('    proxy_read_timeout 300s;\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n  location /api/ {');
  expect(migrated.indexOf('# matrix-speech-upload-limit-v1')).toBeLessThan(migrated.indexOf('# matrix-sites-publish-timeout-v1'));
  migrate(root); expect(await readFile(path, 'utf8')).toBe(migrated);
  await writeFile(path, migrated.replaceAll('http://127.0.0.1:4000', `http://unix:${root}/up.sock:`).replace('proxy_read_timeout 90s;', 'proxy_read_timeout 5s;'));
  await writeFile(join(root, 'etc/nginx/nginx.conf'), (await readFile(join(root, 'etc/nginx/nginx.conf'), 'utf8')).replace('proxy_read_timeout 80ms;', 'proxy_read_timeout 5s;'));
  const child = spawn('/usr/sbin/nginx', ['-p', root, '-c', join(root, 'etc/nginx/nginx.conf'), '-g', 'daemon off; master_process off;'], { stdio: 'ignore' }); children.push(child);
  await waitForSocket(join(root, 'front.sock'), child);
  const tenMinutes = 600 * 16_000 * 2 + 4_096; // PCM16 audio plus multipart framing
  expect(await upload(root, '/api/speech/transcriptions', tenMinutes)).toBe(200);
  expect(await upload(root, '/api/other', tenMinutes)).toBe(413);
  expect(await upload(root, '/api/speech/transcriptions/extra', tenMinutes)).toBe(413);
 } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
it('provisions the same speech upload location for self-hosted installs', async () => {
 const installer = await readFile('scripts/install-server.sh', 'utf8');
 const speech = installer.match(/location = \/api\/speech\/transcriptions \{([\s\S]*?)\n  \}/)?.[1];
 expect(speech).toContain('client_max_body_size 21m;');
 expect(speech).toContain('proxy_read_timeout 90s;');
 expect(speech).toContain('include /opt/matrix/env/gateway-auth-token.conf;');
});
nginxIt('lets an existing VPS accept the save of a 10 MiB document while other API paths keep the 10 MB limit', async () => {
 // Fault: nginx answered 413 for the save of any document over about 7.5 MiB
 // (base64 in a JSON envelope) before the gateway saw it, so the owner could
 // open the file in Docs or Sheets and never save it.
 const root = await fixture();
 const upstream = createServer((req, res) => { req.resume(); req.on('end', () => res.end('saved')); });
 await new Promise<void>(resolve => upstream.listen(join(root, 'up.sock'), resolve));
 try {
  const original = `server { listen unix:${root}/front.sock; server_name _;\n  client_max_body_size 10m;\n  location /api/ {\n    proxy_set_header Authorization "Bearer fixture-only";\n    proxy_pass http://127.0.0.1:4000;\n  }\n}\n`;
  await configuration(root, original); migrate(root);
  const path = join(root, 'etc/nginx/sites-available/matrix'), migrated = await readFile(path, 'utf8');
  expect(migrated).toContain('# matrix-app-file-upload-limit-v1\n  location = /api/bridge/files {\n    client_max_body_size 15m;\n    proxy_set_header Authorization "Bearer fixture-only";\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n  # matrix-speech-upload-limit-v1\n');
  // Helpers from earlier bundles verify that the speech, publishing and API
  // locations follow each other directly; the new location sits above all three.
  expect(migrated).toContain('    proxy_read_timeout 90s;\n    proxy_set_header Authorization "Bearer fixture-only";\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n  # matrix-sites-publish-timeout-v1\n');
  expect(migrated).toContain('    proxy_read_timeout 300s;\n    proxy_set_header Authorization "Bearer fixture-only";\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n  location /api/ {');
  migrate(root); expect(await readFile(path, 'utf8')).toBe(migrated);
  await writeFile(path, migrated.replaceAll('http://127.0.0.1:4000', `http://unix:${root}/up.sock:`));
  await writeFile(join(root, 'etc/nginx/nginx.conf'), (await readFile(join(root, 'etc/nginx/nginx.conf'), 'utf8')).replace('proxy_read_timeout 80ms;', 'proxy_read_timeout 5s;'));
  const child = spawn('/usr/sbin/nginx', ['-p', root, '-c', join(root, 'etc/nginx/nginx.conf'), '-g', 'daemon off; master_process off;'], { stdio: 'ignore' }); children.push(child);
  await waitForSocket(join(root, 'front.sock'), child);
  expect(await upload(root, '/api/bridge/files', MAX_APP_FILE_REQUEST_BYTES)).toBe(200);
  expect(await upload(root, '/api/bridge/files', 16 * 1024 * 1024)).toBe(413);
  expect(await upload(root, '/api/bridge/data', MAX_APP_FILE_REQUEST_BYTES)).toBe(413);
  expect(await upload(root, '/api/bridge/files/extra', MAX_APP_FILE_REQUEST_BYTES)).toBe(413);
 } finally { await new Promise<void>(resolve => upstream.close(() => resolve())); }
});
it('upgrades a VPS that an earlier helper already gave the speech location, and only once', async () => {
 const upgrade = (text: string) => execFileSync('/usr/bin/python3', ['-I', '-B', '-c', 'import sys\nfrom importlib.machinery import SourceFileLoader\nsys.stdout.write(SourceFileLoader("matrix_nginx", sys.argv[1]).load_module().upgrade(sys.stdin.read()))', helper], { input: text, encoding: 'utf8', timeout: 15000 });
 const api = '  location /api/ {\n    proxy_pass http://127.0.0.1:4000;\n  }';
 const publishing = '  # matrix-sites-publish-timeout-v1\n  location ~ "^/api/apps/[a-z0-9][a-z0-9-]{0,63}/site$" {\n    proxy_read_timeout 300s;\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n';
 const speech = '  # matrix-speech-upload-limit-v1\n  location = /api/speech/transcriptions {\n    client_max_body_size 21m;\n    proxy_read_timeout 90s;\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n';
 const files = '  # matrix-app-file-upload-limit-v1\n  location = /api/bridge/files {\n    client_max_body_size 15m;\n    proxy_pass http://127.0.0.1:4000;\n  }\n\n';
 const wrap = (locations: string) => `server {\n  client_max_body_size 10m;\n${locations}\n}\n`;
 const upgraded = wrap(files + speech + publishing + api);
 expect(upgrade(wrap(speech + publishing + api))).toBe(upgraded);
 expect(upgrade(wrap(publishing + api))).toBe(upgraded);
 expect(upgrade(upgraded)).toBe(upgraded);
 // An owner-edited or foreign location for the same path is never rewritten.
 expect(() => upgrade(wrap('  location = /api/bridge/files {\n    return 204;\n  }\n\n' + speech + publishing + api))).toThrow();
 expect(() => upgrade(upgraded.replace('client_max_body_size 15m;', 'client_max_body_size 1m;'))).toThrow();
});
it('sizes the app file location for the largest save the file contract allows', async () => {
 const megabytes = Number((await readFile(helper, 'utf8')).match(/FILES_BODY_LIMIT = "(\d+)m"/)?.[1]);
 expect(megabytes * 1024 * 1024).toBeGreaterThanOrEqual(MAX_APP_FILE_REQUEST_BYTES);
 // The envelope is the file as base64 plus bounded JSON framing.
 expect(MAX_APP_FILE_REQUEST_BYTES).toBeGreaterThan(Math.ceil(APP_FILE_MAX_BYTES / 3) * 4);
});
it('provisions the same app file location for self-hosted installs, in the layout the helper keeps', async () => {
 const installer = await readFile('scripts/install-server.sh', 'utf8');
 const location = installer.match(/# matrix-app-file-upload-limit-v1\n  location = \/api\/bridge\/files \{([\s\S]*?)\n  \}\n\n  # matrix-speech-upload-limit-v1\n/)?.[1];
 expect(location).toBe('\n    client_max_body_size 15m;\n    include /opt/matrix/env/gateway-auth-token.conf;\n    proxy_pass http://127.0.0.1:4000;');
});
