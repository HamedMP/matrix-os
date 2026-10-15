import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const updaterPath = 'distro/customer-vps/host-bin/matrix-sync-agent';

function downloadFunction() {
  const source = readFileSync(updaterPath, 'utf8');
  const start = source.indexOf('bundle_url_is_https() {');
  const end = source.indexOf('prepare_triggered_update_action=apply', start);
  return source.slice(start, end).replaceAll('/usr/bin/timeout', 'timeout');
}

function runDownload(object, { failOnceAt = -1, failAlwaysAt = -1, corruptRange = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-bounded-download-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const objectPath = join(directory, 'object');
  const outputPath = join(directory, 'bundle.tar.gz');
  const curlLog = join(directory, 'curl.log');
  const attempts = join(directory, 'attempts');
  writeFileSync(objectPath, object);
  writeFileSync(curlLog, '');
  writeFileSync(attempts, '{}');
  const fakeTimeout = join(bin, 'timeout');
  writeFileSync(fakeTimeout, '#!/bin/sh\nwhile [ "$1" != "curl" ]; do shift; done\nexec "$@"\n');
  chmodSync(fakeTimeout, 0o755);
  const fakeCurl = join(bin, 'curl');
  writeFileSync(fakeCurl, `#!/usr/bin/env python3
import json,os,sys
args=sys.argv[1:]
def value(flag): return args[args.index(flag)+1]
start,end=map(int,value('--range').split('-'))
out=value('-o'); headers=value('--dump-header')
with open(os.environ['CURL_LOG'],'a') as f:f.write(f'{start}-{end}\\n')
with open(os.environ['ATTEMPTS']) as f: attempts=json.load(f)
key=f'{start}-{end}';attempts[key]=attempts.get(key,0)+1
with open(os.environ['ATTEMPTS'],'w') as f:json.dump(attempts,f)
if start==int(os.environ['FAIL_ALWAYS_AT']) or (start==int(os.environ['FAIL_ONCE_AT']) and attempts[key]==1):
 open(out,'wb').write(b'x');sys.exit(18)
data=open(os.environ['OBJECT_FILE'],'rb').read(); body=data[start:end+1]
if os.environ['CORRUPT_RANGE']=='1': actual_end=end+1
else: actual_end=end
open(headers,'w').write(f'HTTP/1.1 206 Partial Content\\r\\nContent-Range: bytes {start}-{actual_end}/{len(data)}\\r\\nContent-Length: {len(body)}\\r\\n\\r\\n')
open(out,'wb').write(body)
sys.stdout.write('206')
`);
  chmodSync(fakeCurl, 0o755);
  const digest = spawnSync('shasum', ['-a', '256', objectPath], { encoding: 'utf8' }).stdout.split(/\s/)[0];
  const script = `set -euo pipefail
log(){ :; }
write_update_error(){ :; }
json_field(){ python3 -c 'import json,sys;print(json.load(sys.stdin).get(sys.argv[1],""))' "$2" <<< "$1"; }
release_url_for_version(){ printf 'https://platform.example/releases/%s.json' "$1"; }
fetch_manifest(){ printf '%s' "$REFRESHED_JSON"; }
${downloadFunction()}
download_bundle v-test "$SHA256" "$SIZE" https://storage.example/object "$OUTPUT"`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, OBJECT_FILE: objectPath, OUTPUT: outputPath, CURL_LOG: curlLog, ATTEMPTS: attempts, FAIL_ONCE_AT: String(failOnceAt), FAIL_ALWAYS_AT: String(failAlwaysAt), CORRUPT_RANGE: corruptRange ? '1' : '0', SHA256: digest, SIZE: String(object.length), REFRESHED_JSON: JSON.stringify({ version: 'v-test', sha256: digest, size: object.length, url: 'https://storage.example/fresh' }) } });
  const response = { result, output: result.status === 0 ? readFileSync(outputPath) : null, ranges: readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean), directory, chunkDirectory: `${outputPath}.chunks-${digest}` };
  return response;
}

describe('bounded host bundle download', () => {
  it('downloads a bundle in finite ranges and assembles the exact bytes', () => {
    const object = Buffer.alloc(8 * 1024 * 1024 + 17, 7);
    const probe = runDownload(object);
    try {
      assert.equal(probe.result.status,0,probe.result.stderr);
      assert.deepEqual(probe.output,object);
      assert.deepEqual(probe.ranges,['0-8388607', '8388608-8388624']);
    } finally { rmSync(probe.directory, { recursive: true, force: true }); }
  });

  it('retries one failed bounded chunk without restarting completed chunks', () => {
    const object = Buffer.alloc(8 * 1024 * 1024 + 17, 9);
    const probe = runDownload(object, { failOnceAt: 8388608 });
    try {
      assert.equal(probe.result.status,0,probe.result.stderr);
      assert.deepEqual(probe.output,object);
      assert.deepEqual(probe.ranges,['0-8388607', '8388608-8388624', '8388608-8388624']);
    } finally { rmSync(probe.directory, { recursive: true, force: true }); }
  });

  it('rejects a mismatched Content-Range instead of assembling it', () => {
    const probe = runDownload(Buffer.alloc(1024, 3), { corruptRange: true });
    try { assert.notEqual(probe.result.status,0); assert.equal(probe.output,null); }
    finally { rmSync(probe.directory, { recursive: true, force: true }); }
  });

  it('retains only completed bounded chunks after retry exhaustion', () => {
    const probe = runDownload(Buffer.alloc(8 * 1024 * 1024 + 17, 5), { failAlwaysAt: 8388608 });
    try {
      assert.notEqual(probe.result.status,0);
      assert.deepEqual(readFileSync(join(probe.chunkDirectory,'chunk-0')),Buffer.alloc(8 * 1024 * 1024,5));
      assert.deepEqual(probe.ranges,['0-8388607','8388608-8388624','8388608-8388624','8388608-8388624']);
    } finally { rmSync(probe.directory,{recursive:true,force:true}); }
  });
});
