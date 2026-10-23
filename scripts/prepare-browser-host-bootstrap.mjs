#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [stage] = process.argv.slice(2);
if (!stage) throw new Error('Usage: prepare-browser-host-bootstrap.mjs <stage>');
const agentPath = join(stage, 'bin/matrix-sync-agent');
const [agent, release, bootstrap] = await Promise.all([
  readFile(agentPath, 'utf8'), readFile(join(stage, 'release.json'), 'utf8'),
  readFile(new URL('../distro/customer-vps/browser-host-bootstrap.py', import.meta.url), 'utf8'),
]);
const { version, gitCommit } = JSON.parse(release);
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(version) || !/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('Invalid committed Browser build identity');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const files = {};
for (const name of ['matrix-browser-runtime.py', 'matrix-browser-runtime.tar.gz', 'matrix-browser-runtime.tar.gz.sha256']) {
  files[name] = digest(await readFile(join(stage, 'bin', name)));
}
const expected = { version, gitCommit, files, unitSha256: digest(await readFile(join(stage, 'systemd/matrix-browser-runtime.service'))) };
const marker = /# BEGIN Browser host bootstrap[\s\S]*?# END Browser host bootstrap/g;
if (agent.match(marker)?.length !== 1) throw new Error('Missing Browser bootstrap marker');
const inline = `# BEGIN inlined Browser host bootstrap
reconcile_browser_host_bootstrap() {
  [ ! -e "$UPDATE_PHASE_MARKER" ] || return 0
  [ "$(running_gateway_version)" = "$(current_version)" ] || return 1
  sudo /usr/bin/python3 -I - <<'MATRIX_BROWSER_VERIFIED_BOOTSTRAP'
EXPECTED = ${JSON.stringify(expected)}
${bootstrap}
MATRIX_BROWSER_VERIFIED_BOOTSTRAP
}
# END inlined Browser host bootstrap`;
await writeFile(agentPath, agent.replace(marker, () => inline), 'utf8');
