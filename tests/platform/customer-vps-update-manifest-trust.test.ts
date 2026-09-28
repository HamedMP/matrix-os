import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const updaterPath = 'distro/customer-vps/host-bin/matrix-sync-agent';
const sha256 = 'a'.repeat(64);

function verifyMarker(marker: unknown, trusted: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-manifest-'));
  const markerPath = join(directory, 'marker.json');
  const fetchLog = join(directory, 'fetch.log');
  writeFileSync(markerPath, JSON.stringify(marker));
  writeFileSync(fetchLog, '');
  const updater = readFileSync(updaterPath, 'utf8');
  const start = updater.indexOf('load_trusted_apply_manifest() {');
  const end = updater.indexOf('write_prepared_update_marker() {', start);
  const functionSource = start < 0 ? '' : updater.slice(start, end);
  const script = `set -euo pipefail
UPDATE_MARKER="$1"
TRUSTED_JSON="$2"
FETCH_LOG="$3"
log() { :; }
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$2" <<< "$1"; }
release_url_for_version() { printf 'https://platform.example/system-bundles/releases/%s.json\\n' "$1"; }
fetch_manifest() { printf '%s\\n' "$1" >> "$FETCH_LOG"; printf '%s' "$TRUSTED_JSON"; }
${functionSource}
load_trusted_apply_manifest`;
  try {
    const result = spawnSync('bash', ['-c', script, 'test', markerPath, JSON.stringify(trusted), fetchLog], { encoding: 'utf8' });
    return { result, fetched: readFileSync(fetchLog, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function probeApply(marker: unknown, trusted: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-apply-'));
  const markerPath = join(directory, 'marker.json');
  const downloadLog = join(directory, 'download.log');
  writeFileSync(markerPath, JSON.stringify(marker));
  const updater = readFileSync(updaterPath, 'utf8');
  const trustedStart = updater.indexOf('load_trusted_apply_manifest() {');
  const trustedEnd = updater.indexOf('write_prepared_update_marker() {', trustedStart);
  const applyStart = updater.indexOf('apply_update() {');
  const applyEnd = updater.indexOf('run_apply_update() {', applyStart);
  const script = `set -euo pipefail
UPDATE_MARKER="$1"
UPDATE_ERROR_MARKER="$2/error.json"
STAGING_DIR="$2/staging"
APP_DIR="$2"
TRUSTED_JSON="$3"
DOWNLOAD_LOG="$4"
log() { :; }
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$2" <<< "$1"; }
release_url_for_version() { printf 'https://platform.example/system-bundles/releases/%s.json\\n' "$1"; }
fetch_manifest() { printf '%s' "$TRUSTED_JSON"; }
sudo() { :; }
current_version() { printf 'v2026.09.27-1\\n'; }
ensure_update_headroom() { :; }
write_update_phase() { :; }
download_bundle() { printf '%s\\n' "$@" > "$DOWNLOAD_LOG"; return 1; }
${updater.slice(trustedStart, trustedEnd)}
${updater.slice(applyStart, applyEnd)}
apply_update other`;
  try {
    const result = spawnSync('bash', ['-c', script, 'test', markerPath, directory, JSON.stringify(trusted), downloadLog], { encoding: 'utf8' });
    return { result, download: readFileSync(downloadLog, 'utf8') };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('VPS update manifest trust boundary', () => {
  it('uses the marker only for a version and takes URL, digest, and size from the platform', () => {
    const trusted = { version: 'v2026.09.28-1', sha256, size: 100, url: 'https://storage.example/signed-bundle' };
    const { result, fetched } = verifyMarker(
      { version: trusted.version, sha256: 'b'.repeat(64), size: 1, url: 'https://attacker.example/bundle' },
      trusted,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(trusted);
    expect(fetched).toBe('https://platform.example/system-bundles/releases/v2026.09.28-1.json\n');
  });

  it('rejects a forged version before fetching', () => {
    const { result, fetched } = verifyMarker(
      { version: '../../other' },
      { version: '../../other', sha256, size: 100, url: 'https://storage.example/bundle' },
    );
    expect(result.status).not.toBe(0);
    expect(fetched).toBe('');
  });

  it('rejects metadata that does not identify the requested immutable release', () => {
    const { result } = verifyMarker(
      { version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
    );
    expect(result.status).not.toBe(0);
  });

  it('fails closed when the platform omits the digest', () => {
    const { result } = verifyMarker(
      { version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-1', size: 100, url: 'https://storage.example/bundle' },
    );
    expect(result.status).not.toBe(0);
  });

  it('passes only verified platform metadata to the bundle download path', () => {
    const trusted = { version: 'v2026.09.28-1', sha256, size: 100, url: 'https://storage.example/signed-bundle' };
    const { result, download } = probeApply(
      { version: trusted.version, sha256: 'b'.repeat(64), size: 1, url: 'https://attacker.example/bundle' },
      trusted,
    );
    expect(result.status).toBe(1); // The stubbed download stops before installation.
    expect(download.split('\n').slice(0, 4)).toEqual([trusted.version, sha256, '100', trusted.url]);
  });
});
