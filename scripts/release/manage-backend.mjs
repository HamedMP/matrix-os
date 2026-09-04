#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const VERSION = /^(?:v[0-9]|main-[A-Za-z0-9])[A-Za-z0-9._-]{0,126}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

export async function readManagementResponse(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Missing inventory response');
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1_000_000) { await reader.cancel(); throw new Error('Inventory response too large'); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

/** Default operation is read-only. A single CAS update preserves unrelated policy. */
export async function runBackendManagement({ args = [], request }) {
  const [action = 'status', ...flags] = args;
  const option = name => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
  const status = await request('/backend-management/status');
  if (action === 'status' || action === 'verify') {
    const counts = {};
    let page = status, pages = 0;
    do {
      for (const machine of page.machines) counts[machine.status] = (counts[machine.status] ?? 0) + 1;
      if (!page.nextCursor) break;
      if (++pages >= 100 || !ID.test(page.nextCursor)) throw new Error('Inventory pagination unavailable');
      page = await request(`/backend-management/status?after=${encodeURIComponent(page.nextCursor)}`);
    } while (true);
    return { enabled: status.policy.config.enabled, activeVersion: status.policy.activeVersion, counts,
      attentionRequired: status.policy.config.enabled && Boolean(counts.blocked || counts.offline) };
  }
  const config = { ...status.policy.config };
  if (action === 'enable') {
    const bridge = option('--bridge'), canary = option('--canary');
    if (!bridge || !VERSION.test(bridge) || !canary || !ID.test(canary)) throw new Error('Enable requires --bridge <reviewed-version> and --canary <machine-id>');
    config.enabled = true; config.bootstrapVersion = bridge; config.canaryMachineIds = [canary];
  } else if (action === 'publish-client') {
    const target = option('--target'), latest = option('--latest'), download = option('--download');
    if (!['desktop-macos', 'desktop-windows', 'desktop-linux', 'mobile-ios', 'mobile-android'].includes(target)
      || !latest || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(latest) || !download) throw new Error('Publish client requires target, stable version and verified download URL');
    const existing = config.clients[target];
    if (existing) {
      const a = existing.latestVersion.split('.').map(Number), b = latest.split('.').map(Number);
      const differing = a.findIndex((value, index) => value !== b[index]);
      if (differing >= 0 && a[differing] > b[differing]) return { skippedOlderRelease: true };
    }
    config.clients = { ...config.clients, [target]: { minSupportedVersion: '0.0.0', enforceAfter: '1970-01-01T00:00:00.000Z', ...existing, latestVersion: latest, downloadUrl: download } };
  } else if (action === 'pause') { config.enabled = false; }
  else if (action === 'follow-stable') {
    if (!config.enabled || !config.bootstrapVersion) throw new Error('Complete the enabled bridge rollout first');
    // Verify every customer that is currently running. Offline/suspended machines
    // are not silently treated as migrated; operators must recover them first.
    let page = status;
    for (let pageIndex = 0; ; pageIndex++) {
      if (page.machines.some(machine => machine.status !== 'current' || machine.observedVersion !== config.bootstrapVersion)) throw new Error('Bridge fleet is not fully verified');
      if (!page.nextCursor) break;
      if (pageIndex >= 100 || !ID.test(page.nextCursor)) throw new Error('Inventory pagination unavailable');
      page = await request(`/backend-management/status?after=${encodeURIComponent(page.nextCursor)}`);
    }
    config.bootstrapVersion = null;
  } else if (action === 'set-clients') {
    const file = option('--file');
    if (!file || !flags.includes('--artifacts-verified')) throw new Error('Client policy requires --file and --artifacts-verified after checking store/installers');
    const text = await readFile(file, 'utf8');
    if (text.length > 16_384) throw new Error('Policy file too large');
    config.clients = JSON.parse(text);
  } else if (action === 'retry') {
    const machineId = option('--machine');
    if (!machineId || !ID.test(machineId)) throw new Error('Retry requires --machine');
    await request(`/backend-management/machines/${machineId}/retry`, { method: 'POST', body: {} });
    return { retryRequested: true };
  } else { throw new Error('Unknown management action'); }
  await request('/backend-management/policy', { method: 'PUT', body: { revision: status.policy.revision, config } });
  return { policyUpdated: true, enabled: config.enabled, bootstrapVersion: config.bootstrapVersion };
}

async function main() {
  const base = new URL(process.env.PLATFORM_PUBLIC_URL ?? 'https://app.matrix-os.com');
  if (base.protocol !== 'https:' || base.username || base.password) throw new Error('HTTPS platform URL required');
  const secret = process.env.PLATFORM_SECRET;
  if (!secret) throw new Error('PLATFORM_SECRET is required');
  const request = async (path, options = {}) => {
    const response = await fetch(new URL(path, base), { method: options.method ?? 'GET',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Management request failed (${response.status})`); }
    return readManagementResponse(response);
  };
  const result = await runBackendManagement({ args: process.argv.slice(2), request });
  // No customer identifiers, IPs, policy URLs or credentials in workflow logs.
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[2] === 'verify' && result.attentionRequired) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Management failed'); process.exitCode = 1; });
}
