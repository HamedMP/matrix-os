import { afterEach, expect, it } from 'vitest';
import { readFile, writeFile, mkdtemp, mkdir, rm, stat, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, request } from 'node:http';
import { parse } from 'yaml';

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
 expect(changed.match(/proxy_set_header Authorization "Bearer fixture-only";/g)).toHaveLength(2);
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
