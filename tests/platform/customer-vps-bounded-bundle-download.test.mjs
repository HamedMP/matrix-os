import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const updaterPath = 'distro/customer-vps/host-bin/matrix-sync-agent';
function downloadFunction(deadlineSeconds = 3600) {
  const source = readFileSync(updaterPath, 'utf8');
  const start = source.indexOf('bundle_url_is_https() {');
  const end = source.indexOf('prepare_triggered_update_action=apply', start);
  return source.slice(start, end).replaceAll('/usr/bin/timeout', 'timeout')
    .replace('local transfer_deadline_seconds=3600', `local transfer_deadline_seconds=${deadlineSeconds}`);
}
function runDownload(object, options = {}) {
  const { failOnceAt = -1, failAlwaysAt = -1, corruptRange = false, responseStatus = 206,
    sleepSeconds = 0, sleepAt = -1, deadlineSeconds = 3600, incomingAttack = '', chunkDirectoryMode,
    headerMode = 'valid', moveFailure = '', moveFailureAt = -1, declaredSize = object.length,
    directory = mkdtempSync(join(tmpdir(), 'matrix-bounded-download-')) } = options;
  const bin = join(directory, 'bin'); mkdirSync(bin, { recursive: true });
  const objectPath = join(directory, 'object'); const outputPath = join(directory, 'bundle.tar.gz');
  const protectedPath = join(directory, 'protected'); const curlLog = join(directory, 'curl.log');
  const attempts = join(directory, 'attempts');
  writeFileSync(objectPath, object); writeFileSync(protectedPath, 'must-not-change');
  writeFileSync(curlLog, ''); writeFileSync(attempts, '{}');
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nwhile [ "$1" != "curl" ]; do shift; done\nexec "$@"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env python3
import json,os,sys,time
args=sys.argv[1:]
def value(flag): return args[args.index(flag)+1]
start,end=map(int,value('--range').split('-'));out=value('-o');headers=value('--dump-header')
if start==int(os.environ['SLEEP_AT']) and int(os.environ['SLEEP_SECONDS']): time.sleep(int(os.environ['SLEEP_SECONDS']))
with open(os.environ['CURL_LOG'],'a') as f:f.write(f'{start}-{end}\\n')
with open(os.environ['ATTEMPTS']) as f: attempts=json.load(f)
key=f'{start}-{end}';attempts[key]=attempts.get(key,0)+1
with open(os.environ['ATTEMPTS'],'w') as f:json.dump(attempts,f)
if start==int(os.environ['FAIL_ALWAYS_AT']) or (start==int(os.environ['FAIL_ONCE_AT']) and attempts[key]==1):
 open(out,'wb').write(b'x');sys.exit(18)
data=open(os.environ['OBJECT_FILE'],'rb').read();body=data[start:end+1]
actual_end=end+1 if os.environ['CORRUPT_RANGE']=='1' else end
status=os.environ['RESPONSE_STATUS']
valid=f'HTTP/1.1 {status} Response\\r\\nContent-Range: bytes {start}-{actual_end}/{len(data)}\\r\\nContent-Length: {len(body)}\\r\\n\\r\\n'
if os.environ['HEADER_MODE']=='redirect_forged_final_missing':
 headers_text=f'HTTP/1.1 301 Redirect\\r\\nContent-Range: bytes {start}-{end}/{len(data)}\\r\\nLocation: https://storage.example/final\\r\\n\\r\\nHTTP/1.1 206 Response\\r\\nContent-Length: {len(body)}\\r\\n\\r\\n'
elif os.environ['HEADER_MODE']=='final_conflicting':
 headers_text=valid.replace('Content-Length:',f'Content-Range: bytes {start}-{end}/{len(data)}\\r\\nContent-Length:')
else: headers_text=valid
open(headers,'w').write(headers_text)
open(out,'wb').write(body);sys.stdout.write(status)
`, { mode: 0o755 });
  writeFileSync(join(bin, 'mktemp'), `#!/bin/bash
set -euo pipefail
template="\${1:?}"
if [[ "$template" == *.incoming.XXXXXX && -n "\${INCOMING_ATTACK:-}" ]]; then
 path="\${template%XXXXXX}attack";rm -f -- "$path"
 if [ "$INCOMING_ATTACK" = symlink ]; then ln -s -- "$PROTECTED_PATH" "$path"; else ln -- "$PROTECTED_PATH" "$path"; fi
 printf '%s\\n' "$path"
else
 /usr/bin/mktemp "$@"
fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'mv'), `#!/bin/bash
set -euo pipefail
src="\${@: -2:1}";dst="\${@: -1}"
if [[ "\${MOVE_FAILURE:-}" == intermediate && "$src" == */.chunk-"\${MOVE_FAILURE_AT}".* ]] ||
   [[ "\${MOVE_FAILURE:-}" == final && "$src" == *.incoming.* ]]; then exit 1; fi
exec /bin/mv "$@"
`, { mode: 0o755 });
  const digest = spawnSync('shasum', ['-a', '256', objectPath], { encoding: 'utf8' }).stdout.split(/\s/)[0];
  const chunkDirectory = `${outputPath}.chunks-${digest}`;
  let initialChunkNlink;
  if (chunkDirectoryMode !== undefined) { mkdirSync(chunkDirectory, { mode: chunkDirectoryMode }); chmodSync(chunkDirectory, chunkDirectoryMode); }
  if (chunkDirectoryMode !== undefined) initialChunkNlink = lstatSync(chunkDirectory).nlink;
  const script = `set -euo pipefail
log(){ :; }
write_update_error(){ :; }
json_field(){ python3 -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1],""))' "$2" <<< "$1"; }
release_url_for_version(){ printf 'https://platform.example/releases/%s.json' "$1"; }
fetch_manifest(){ printf '%s' "$REFRESHED_JSON"; }
${downloadFunction(deadlineSeconds)}
before_umask="$(umask)";set +e
download_bundle v-test "$SHA256" "$SIZE" https://storage.example/object "$OUTPUT"
rc=$?;set -e
[ "$(umask)" = "$before_umask" ] || exit 99
exit "$rc"`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env,
    PATH: `${bin}:${process.env.PATH}`, OBJECT_FILE: objectPath, OUTPUT: outputPath, CURL_LOG: curlLog,
    ATTEMPTS: attempts, FAIL_ONCE_AT: String(failOnceAt), FAIL_ALWAYS_AT: String(failAlwaysAt),
    CORRUPT_RANGE: corruptRange ? '1' : '0', RESPONSE_STATUS: String(responseStatus), SLEEP_SECONDS: String(sleepSeconds), SLEEP_AT: String(sleepAt),
    INCOMING_ATTACK: incomingAttack, HEADER_MODE: headerMode, MOVE_FAILURE: moveFailure, MOVE_FAILURE_AT: String(moveFailureAt), PROTECTED_PATH: protectedPath,
    SHA256: digest, SIZE: String(declaredSize),
    REFRESHED_JSON: JSON.stringify({ version: 'v-test', sha256: digest, size: declaredSize, url: 'https://storage.example/fresh' }) } });
  return { result, output: result.status === 0 ? readFileSync(outputPath) : null,
    ranges: readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean), directory, chunkDirectory, protectedPath, initialChunkNlink };
}
function cleanup(probe) { rmSync(probe.directory, { recursive: true, force: true }); }

describe('bounded host bundle download', () => {
  it('downloads finite ranges and assembles exact bytes without changing caller umask', () => {
    const object = Buffer.alloc(8 * 1024 * 1024 + 17, 7); const probe = runDownload(object);
    try { assert.equal(probe.result.status, 0, probe.result.stderr); assert.deepEqual(probe.output, object); assert.deepEqual(probe.ranges, ['0-8388607', '8388608-8388624']); } finally { cleanup(probe); }
  });
  it('retries a failed chunk without restarting completed chunks', () => {
    const object = Buffer.alloc(8 * 1024 * 1024 + 17, 9); const probe = runDownload(object, { failOnceAt: 8388608 });
    try { assert.equal(probe.result.status, 0, probe.result.stderr); assert.deepEqual(probe.output, object); assert.equal(probe.ranges.length, 3); } finally { cleanup(probe); }
  });
  for (const options of [{ corruptRange: true }, { responseStatus: 200 }]) {
    it(`rejects invalid range response ${JSON.stringify(options)}`, () => {
      const probe = runDownload(Buffer.alloc(1024, 3), options);
      try { assert.notEqual(probe.result.status, 0); assert.equal(probe.output, null); } finally { cleanup(probe); }
    });
  }
  for (const headerMode of ['redirect_forged_final_missing', 'final_conflicting']) {
    it(`rejects untrusted Content-Range headers in ${headerMode}`, () => {
      const probe = runDownload(Buffer.alloc(1024, 3), { headerMode });
      try { assert.notEqual(probe.result.status, 0); assert.equal(probe.output, null); } finally { cleanup(probe); }
    });
  }
  it('enforces the whole-transfer deadline while retaining completed chunks', () => {
    const probe = runDownload(Buffer.alloc(8 * 1024 * 1024 + 17, 6), { deadlineSeconds: 2, sleepSeconds: 3, sleepAt: 8388608 });
    try { assert.notEqual(probe.result.status, 0); assert.equal(probe.ranges.length, 2); assert.deepEqual(readFileSync(join(probe.chunkDirectory, 'chunk-0')), Buffer.alloc(8 * 1024 * 1024, 6)); } finally { cleanup(probe); }
  });
  for (const incomingAttack of ['symlink', 'hardlink']) {
    it(`refuses a ${incomingAttack} assembly destination without changing its target`, () => {
      const probe = runDownload(Buffer.alloc(1024, 8), { incomingAttack });
      try { assert.notEqual(probe.result.status, 0); assert.equal(readFileSync(probe.protectedPath, 'utf8'), 'must-not-change'); } finally { cleanup(probe); }
    });
  }
  it('rejects an existing chunk directory that is not private', () => {
    const probe = runDownload(Buffer.alloc(1024, 2), { chunkDirectoryMode: 0o755 });
    try { assert.notEqual(probe.result.status, 0); assert.deepEqual(probe.ranges, []); } finally { cleanup(probe); }
  });
  it('accepts a private Linux directory with the normal link count of two', { skip: process.platform !== 'linux' }, () => {
    const probe = runDownload(Buffer.alloc(1024, 2), { chunkDirectoryMode: 0o700 });
    try { assert.equal(probe.initialChunkNlink, 2); assert.equal(probe.result.status, 0, probe.result.stderr); }
    finally { cleanup(probe); }
  });
  it('retains only completed chunks after retry exhaustion', () => {
    const probe = runDownload(Buffer.alloc(8 * 1024 * 1024 + 17, 5), { failAlwaysAt: 8388608 });
    try { assert.notEqual(probe.result.status, 0); assert.deepEqual(readFileSync(join(probe.chunkDirectory, 'chunk-0')), Buffer.alloc(8 * 1024 * 1024, 5)); assert.equal(probe.ranges.length, 4); } finally { cleanup(probe); }
  });
  it('accepts the canonical 20 GiB manifest limit before attempting bounded ranges', () => {
    const probe = runDownload(Buffer.alloc(1024, 1), { declaredSize: 20 * 1024 * 1024 * 1024 });
    try { assert.notEqual(probe.result.status, 0); assert.equal(probe.ranges.length, 3); }
    finally { cleanup(probe); }
  });
  it('fails closed when an intermediate chunk move fails and retains earlier chunks', () => {
    const probe = runDownload(Buffer.alloc(8 * 1024 * 1024 + 17, 4), { moveFailure: 'intermediate', moveFailureAt: 1 });
    try { assert.notEqual(probe.result.status, 0); assert.equal(probe.output, null); assert.equal(readFileSync(join(probe.chunkDirectory, 'chunk-0')).length, 8 * 1024 * 1024); }
    finally { cleanup(probe); }
  });
  it('retains completed chunks after a final move failure and resumes without redownloading', () => {
    const object = Buffer.alloc(1024, 8); const first = runDownload(object, { moveFailure: 'final' });
    try {
      assert.notEqual(first.result.status, 0); assert.deepEqual(readFileSync(join(first.chunkDirectory, 'chunk-0')), object);
      const resumed = runDownload(object, { directory: first.directory });
      try { assert.equal(resumed.result.status, 0, resumed.result.stderr); assert.deepEqual(resumed.output, object); assert.deepEqual(resumed.ranges, []); }
      finally { cleanup(resumed); }
    } catch (error) { cleanup(first); throw error; }
  });
});
