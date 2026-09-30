import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const updaterPath = 'distro/customer-vps/host-bin/matrix-sync-agent';
const sha256 = 'a'.repeat(64);

function expandedUpdater(): string {
  return readFileSync(updaterPath, 'utf8')
    .replace(/# BEGIN update manifest library loader[\s\S]*?# END update manifest library loader/,
      () => readFileSync('distro/customer-vps/host-bin/matrix-update-manifest', 'utf8'))
    .replace(/# BEGIN update request rejection library loader[\s\S]*?# END update request rejection library loader/, '');
}

function verifyMarker(marker: unknown, trusted: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-manifest-'));
  const markerPath = join(directory, 'marker.json');
  const fetchLog = join(directory, 'fetch.log');
  writeFileSync(markerPath, JSON.stringify(marker));
  writeFileSync(fetchLog, '');
  const updater = expandedUpdater();
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

function probeApply(marker: unknown, trusted: unknown, badDigest = false) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-apply-'));
  const markerPath = join(directory, 'marker.json');
  const downloadLog = join(directory, 'download.log');
  const errorLog = join(directory, 'error.log');
  const installLog = join(directory, 'install.log');
  mkdirSync(join(directory, 'staging'));
  writeFileSync(markerPath, JSON.stringify(marker));
  const updater = expandedUpdater();
  const rejectionLibrary = readFileSync('distro/customer-vps/host-bin/matrix-update-request-rejection', 'utf8');
  const trustedStart = updater.indexOf('load_trusted_apply_manifest() {');
  const trustedEnd = updater.indexOf('write_prepared_update_marker() {', trustedStart);
  const applyStart = updater.indexOf('apply_update() {');
  const applyEnd = updater.indexOf('run_apply_update() {', applyStart);
  const prepareStart = updater.indexOf('prepare_triggered_update() {');
  const prepareEnd = updater.indexOf('# ── Poll for updates', prepareStart);
  const script = `set -euo pipefail
UPDATE_MARKER="$1"
UPDATE_ERROR_MARKER="$2/error.json"
STAGING_DIR="$2/staging"
APP_DIR="$2"
TRUSTED_JSON="$3"
DOWNLOAD_LOG="$4"
ERROR_LOG="$5"
INSTALL_LOG="$6"
log() { :; }
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$2" <<< "$1"; }
release_url_for_version() { printf 'https://platform.example/system-bundles/releases/%s.json\\n' "$1"; }
fetch_manifest() { printf '%s' "$TRUSTED_JSON"; }
sudo() { :; }
current_version() { printf 'v2026.09.27-1\\n'; }
ensure_update_headroom() { :; }
write_update_phase() { :; }
write_update_error() { printf '%s' "$1" > "$ERROR_LOG"; }
tar() { printf 'reached' > "$INSTALL_LOG"; return 1; }
download_bundle() { printf '%s\\n' "$@" > "$DOWNLOAD_LOG"; ${badDigest ? 'printf corrupt > "$5"; return 0;' : 'return 1;'} }
${rejectionLibrary}
${updater.slice(trustedStart, trustedEnd)}
${updater.slice(applyStart, applyEnd)}
apply_update other`;
  try {
    const result = spawnSync('bash', ['-c', script, 'test', markerPath, directory, JSON.stringify(trusted), downloadLog, errorLog, installLog], { encoding: 'utf8' });
    return {
      result,
      download: readFileSync(downloadLog, 'utf8'),
      error: existsSync(errorLog) ? readFileSync(errorLog, 'utf8') : '',
      installReached: existsSync(installLog),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function probeRejectedExplicitRequest(marker: unknown, trusted: unknown, metadataAvailable = true, replaceRequestDuringValidation = false, triggerOnlyDuringCleanup = false, prepareAfterRejection: false | "plain" | "replacement" = false, initialTarget: "marker" | "version" | "channel" = "marker") {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-rejected-'));
  const markerPath = join(directory, '.update-available.json');
  const triggerPath = join(directory, '.update-now');
  const errorLog = join(directory, 'error.log');
  const downloadLog = join(directory, 'download.log');
  writeFileSync(markerPath, JSON.stringify(marker));
  writeFileSync(triggerPath, '');
  if (initialTarget === 'version') writeFileSync(join(directory, '.update-version'), 'v2026.09.28-1');
  if (initialTarget === 'channel') writeFileSync(join(directory, '.update-channel'), 'beta');
  const updater = expandedUpdater();
  const rejectionLibrary = readFileSync('distro/customer-vps/host-bin/matrix-update-request-rejection', 'utf8');
  const trustedStart = updater.indexOf('load_trusted_apply_manifest() {');
  const trustedEnd = updater.indexOf('write_prepared_update_marker() {', trustedStart);
  const applyStart = updater.indexOf('apply_update() {');
  const applyEnd = updater.indexOf('run_apply_update() {', applyStart);
  const prepareStart = updater.indexOf('prepare_triggered_update() {');
  const prepareEnd = updater.indexOf('# ── Poll for updates', prepareStart);
  const script = `set -euo pipefail
UPDATE_MARKER="$1"
UPDATE_TRIGGER="$2"
UPDATE_VERSION_FILE="$3/.update-version"
UPDATE_CHANNEL_FILE="$3/.update-channel"
UPDATE_ERROR_MARKER="$3/error.json"
STAGING_DIR="$3/staging"
APP_DIR="$3"
FETCH_LOG="$APP_DIR/fetch.log"
TRUSTED_JSON="$4"
ERROR_LOG="$5"
DOWNLOAD_LOG="$6"
log() { :; }
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$2" <<< "$1"; }
release_url_for_version() { printf 'https://platform.example/system-bundles/releases/%s.json\\n' "$1"; }
fetch_manifest() { printf '%s\\n' \"$1\" >> \"$FETCH_LOG\"; ${replaceRequestDuringValidation ? 'printf v2026.09.28-2 > "$APP_DIR/.update-version"; : > "$APP_DIR/new-trigger"; mv -fT "$APP_DIR/new-trigger" "$UPDATE_TRIGGER";' : ''} ${metadataAvailable ? 'printf \'%s\' "$TRUSTED_JSON";' : 'return 1;'} }
sudo() { "$@"; }
${triggerOnlyDuringCleanup ? 'rm() { if [[ "$*" == *".update-rejected."* ]]; then : > "$UPDATE_TRIGGER"; fi; command rm "$@"; }' : ''}
consume_update_trigger() { sudo rm -f -- "$UPDATE_TRIGGER"; }
current_version() { printf 'v2026.09.27-1\\n'; }
ensure_update_headroom() { :; }
write_update_phase() { :; }
write_update_error() { printf '%s|%s' "$1" "\${3:-}" > "$ERROR_LOG"; }
download_bundle() { printf reached > "$DOWNLOAD_LOG"; return 1; }
${rejectionLibrary}
${updater.slice(trustedStart, trustedEnd)}
${updater.slice(applyStart, applyEnd)}
${updater.slice(prepareStart, prepareEnd)}
apply_update explicit || result=$?
${prepareAfterRejection ? `
${prepareAfterRejection === "replacement" ? `printf '%s' '{"version":"v2026.09.28-3"}' > "$UPDATE_MARKER"` : ''}
: > "$UPDATE_TRIGGER"
default_update_channel() { printf stable; }
manifest_url() { printf 'https://platform.example/channel.json'; }
release_url_for_channel() { printf 'https://platform.example/channels/%s.json' "$1"; }
requested_update_is_already_current() { return 1; }
write_prepared_update_marker() { printf '%s' "$1" > "$UPDATE_MARKER"; }
prepare_triggered_update || exit 9
` : ''}
exit "\${result:-0}"`;
  try {
    const result = spawnSync('bash', ['-c', script, 'test', markerPath, triggerPath, directory, JSON.stringify(trusted), errorLog, downloadLog], { encoding: 'utf8' });
    return {
      result,
      markerExists: existsSync(markerPath),
      marker: existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null,
      triggerExists: existsSync(triggerPath),
      fetched: existsSync(join(directory, 'fetch.log')) ? readFileSync(join(directory, 'fetch.log'), 'utf8').trim().split('\n') : [],
      requestedVersion: existsSync(join(directory, '.update-version')) ? readFileSync(join(directory, '.update-version'), 'utf8') : null,
      error: existsSync(errorLog) ? readFileSync(errorLog, 'utf8') : '',
      downloadReached: existsSync(downloadLog),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function probeRetryUrl(refreshedUrl: string) {
  const directory = mkdtempSync(join(tmpdir(), 'matrix-update-retry-url-'));
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  const curlLog = join(directory, 'curl.log');
  const errorLog = join(directory, 'error.log');
  const fakeCurl = join(bin, 'curl');
  writeFileSync(fakeCurl, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CURL_LOG"\nexit 1\n');
  chmodSync(fakeCurl, 0o755);
  writeFileSync(curlLog, '');
  const updater = expandedUpdater();
  const start = updater.indexOf('bundle_url_is_https() {');
  const end = updater.indexOf('prepare_triggered_update_action=apply', start);
  const script = `set -euo pipefail
log() { :; }
json_field() { python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$2" <<< "$1"; }
release_url_for_version() { printf 'https://platform.example/releases/%s.json\\n' "$1"; }
fetch_manifest() { printf '%s' "$REFRESHED_JSON"; }
write_update_error() { printf '%s' "$1" > "$ERROR_LOG"; }
${updater.slice(start, end)}
download_bundle v2026.09.28-1 "$SHA256" 100 https://storage.example/initial "$1/bundle.tar.gz"`;
  try {
    const result = spawnSync('bash', ['-c', script, 'test', directory], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        CURL_LOG: curlLog,
        ERROR_LOG: errorLog,
        SHA256: sha256,
        REFRESHED_JSON: JSON.stringify({ version: 'v2026.09.28-1', sha256, size: 100, url: refreshedUrl }),
      },
    });
    return {
      result,
      curlCalls: readFileSync(curlLog, 'utf8').trim().split('\n').filter(Boolean),
      error: existsSync(errorLog) ? readFileSync(errorLog, 'utf8') : '',
    };
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

  it('stops before extraction when downloaded bytes do not match the platform digest', () => {
    const trusted = { version: 'v2026.09.28-1', sha256, size: 100, url: 'https://storage.example/signed-bundle' };
    const { result, error, installReached } = probeApply({ version: trusted.version }, trusted, true);
    expect(result.status).toBe(1);
    expect(error).toBe('checksum_mismatch');
    expect(installReached).toBe(false);
  });

  it('rejects a retry manifest that changes the bundle URL to HTTP', () => {
    const { result, curlCalls, error } = probeRetryUrl('http://storage.example/plaintext-bundle');
    expect(result.status).toBe(1);
    expect(curlCalls).toHaveLength(1);
    expect(curlCalls[0]).toContain('--proto =https --proto-redir =https');
    expect(error).toBe('download_metadata_changed');
  });

  it('consumes a permanently malformed trigger so channel polling can resume', () => {
    const { result, markerExists, triggerExists, error, downloadReached } = probeRejectedExplicitRequest(
      { version: '../x', url: 'https://attacker.example/bundle', sha256: 'b'.repeat(64), size: 1 },
      { version: '../x', sha256, size: 100, url: 'https://storage.example/bundle' },
    );
    expect(result.status).toBe(1);
    expect(triggerExists).toBe(false);
    expect(markerExists).toBe(true);
    expect(error).toBe('update_request_rejected|');
    expect(downloadReached).toBe(false);
  });

  it('consumes an invalid metadata trigger without downloading', () => {
    const result = probeRejectedExplicitRequest({ version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-1', size: 100, url: 'https://storage.example/bundle' });
    expect(result.triggerExists).toBe(false);
    expect(result.markerExists).toBe(true);
    expect(result.downloadReached).toBe(false);
  });

  it('preserves a newer trigger and target written during failed validation', () => {
    const { result, markerExists, triggerExists, requestedVersion, downloadReached } = probeRejectedExplicitRequest(
      { version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
      true,
      true,
    );
    expect(result.status).toBe(1);
    expect(markerExists).toBe(true);
    expect(triggerExists).toBe(true);
    expect(requestedVersion).toBe('v2026.09.28-2');
    expect(downloadReached).toBe(false);
  });

  it('keeps the prepared target for a trigger-only apply arriving during rejected-request cleanup', () => {
    const marker = { version: 'v2026.09.28-1' };
    const result = probeRejectedExplicitRequest(marker,
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
      true, false, true);
    expect(result.result.status, result.result.stderr).toBe(1);
    expect(result.triggerExists).toBe(true);
    expect(result.marker).toEqual(marker);
    expect(result.downloadReached).toBe(false);
  });

  it('refreshes the channel for a later plain apply after permanent rejection', () => {
    const result = probeRejectedExplicitRequest({ version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
      true, false, false, 'plain');
    expect(result.result.status, result.result.stderr).toBe(1);
    expect(result.triggerExists).toBe(true);
    expect(result.marker.version).toBe('v2026.09.28-2');
    expect(result.downloadReached).toBe(false);
  });

  it.each(['version', 'channel'] as const)('skips the unchanged rejected %s target for a later plain apply', (initialTarget) => {
    const result = probeRejectedExplicitRequest({ version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
      true, false, false, 'plain', initialTarget);
    expect(result.result.status, result.result.stderr).toBe(1);
    expect(result.marker.version).toBe('v2026.09.28-2');
    expect(result.fetched.at(-1)).toBe('https://platform.example/channel.json');
    expect(result.triggerExists).toBe(true);
    expect(result.downloadReached).toBe(false);
  });

  it('preserves a replacement prepared target after permanent rejection', () => {
    const result = probeRejectedExplicitRequest({ version: 'v2026.09.28-1' },
      { version: 'v2026.09.28-2', sha256, size: 100, url: 'https://storage.example/bundle' },
      true, false, false, 'replacement');
    expect(result.result.status, result.result.stderr).toBe(1);
    expect(result.marker.version).toBe('v2026.09.28-3');
    expect(result.downloadReached).toBe(false);
  });

  it('background polling leaves a pending explicit release unchanged', () => {
    const directory = mkdtempSync(join(tmpdir(), 'matrix-update-pending-'));
    const markerPath = join(directory, 'marker.json');
    const triggerPath = join(directory, 'trigger');
    const pollLog = join(directory, 'poll.log');
    const marker = JSON.stringify({ version: 'v2026.09.28-1' });
    writeFileSync(markerPath, marker);
    writeFileSync(triggerPath, '');
    const updater = expandedUpdater();
    const start = updater.indexOf('check_for_update() {');
    const end = updater.indexOf('# ── Apply update', start);
    try {
      const result = spawnSync('bash', ['-c', `set -euo pipefail
UPDATE_TRIGGER="$1"
UPDATE_MARKER="$2"
POLL_LOG="$3"
log() { :; }
manifest_url() { printf 'https://platform.example/channel.json'; }
curl() { printf reached > "$POLL_LOG"; return 1; }
${updater.slice(start, end)}
check_for_update`, 'test', triggerPath, markerPath, pollLog], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(pollLog)).toBe(false);
      expect(readFileSync(markerPath, 'utf8')).toBe(marker);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('preserves an explicit request through a temporary metadata outage', () => {
    const { result, markerExists, triggerExists, error, downloadReached } = probeRejectedExplicitRequest(
      { version: 'v2026.09.28-1' },
      {},
      false,
    );
    expect(result.status).toBe(1);
    expect(triggerExists).toBe(true);
    expect(markerExists).toBe(true);
    expect(error).toBe('update_request_rejected|');
    expect(downloadReached).toBe(false);
  });
});
