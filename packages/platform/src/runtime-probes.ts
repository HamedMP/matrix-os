import type { Agent } from 'undici';

import type { RuntimePickerMachine } from './auth-pages.js';
import type { UserMachineRecord } from './db.js';
import { buildCustomerVpsProxyUrl } from './profile-routing.js';
import { buildPlatformVerificationToken } from './platform-token.js';

const VPS_RELEASE_PROBE_TIMEOUT_MS = 10_000;
const RUNTIME_PICKER_PROBE_TIMEOUT_MS = 2_500;

export async function probeCustomerVpsRelease(
  machine: UserMachineRecord,
  platformSecret: string,
  options: {
    timeoutMs?: number;
    dispatcher: Agent;
  },
): Promise<{
  reachable: boolean;
  statusCode?: number;
  release?: unknown;
  startedAt?: string;
  error?: string;
}> {
  const targetUrl = buildCustomerVpsProxyUrl(machine, '/api/system/info');
  if (!targetUrl) {
    return { reachable: false, error: 'VPS unreachable' };
  }
  if (!platformSecret) {
    return { reachable: false, error: 'Platform auth unavailable' };
  }
  const headers = new Headers({
    authorization: `Bearer ${buildPlatformVerificationToken(machine.handle, platformSecret)}`,
    host: 'app.matrix-os.com',
    'x-forwarded-host': 'app.matrix-os.com',
    'x-forwarded-proto': 'https',
    connection: 'close',
  });
  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? VPS_RELEASE_PROBE_TIMEOUT_MS),
      dispatcher: options.dispatcher,
    } as RequestInit & { dispatcher: Agent });
    if (!response.ok) {
      return { reachable: false, statusCode: response.status, error: 'System info unavailable' };
    }
    const info = await response.json() as { release?: unknown; startedAt?: string };
    return {
      reachable: true,
      statusCode: response.status,
      release: info.release,
      startedAt: info.startedAt,
    };
  } catch (err: unknown) {
    console.warn(
      `[platform] VPS release probe failed handle=${machine.handle} machine=${machine.machineId} error=${describeError(err)}`,
    );
    return { reachable: false, error: 'VPS release probe failed' };
  }
}

export async function probeCustomerVpsRuntime(
  machine: { handle: string; publicIPv4: string | null },
  platformSecret: string,
  dispatcher: Agent,
): Promise<{
  healthy: boolean;
  runtimeVersion?: string | null;
  probeLatencyMs?: number;
  load1?: number | null;
  cpuCount?: number | null;
  memoryTotalBytes?: number | null;
  memoryFreeBytes?: number | null;
  diskTotalBytes?: number | null;
  diskFreeBytes?: number | null;
}> {
  if (!machine.publicIPv4) return { healthy: false };
  if (!platformSecret) return { healthy: false };
  const token = buildPlatformVerificationToken(machine.handle, platformSecret);
  const started = performance.now();
  try {
    const res = await fetch(`https://${machine.publicIPv4}:443/api/system/info`, {
      headers: {
        authorization: `Bearer ${token}`,
        host: 'app.matrix-os.com',
        'x-forwarded-host': 'app.matrix-os.com',
        'x-forwarded-proto': 'https',
      },
      dispatcher,
      signal: AbortSignal.timeout(8_000),
    } as RequestInit & { dispatcher: Agent });
    const probeLatencyMs = performance.now() - started;
    if (!res.ok) return { healthy: false, probeLatencyMs };

    const info = await res.json() as {
      release?: {
        version?: unknown;
      };
      resources?: {
        cpuCount?: number;
        loadAverage?: unknown;
        memoryTotalBytes?: number;
        memoryFreeBytes?: number;
        diskTotalBytes?: number | null;
        diskFreeBytes?: number | null;
      };
    };
    const loadAverage = Array.isArray(info.resources?.loadAverage) ? info.resources.loadAverage : [];
    const load1 = typeof loadAverage[0] === 'number' ? loadAverage[0] : null;
    return {
      healthy: true,
      runtimeVersion: typeof info.release?.version === 'string' ? info.release.version : null,
      probeLatencyMs,
      load1,
      cpuCount: typeof info.resources?.cpuCount === 'number' ? info.resources.cpuCount : null,
      memoryTotalBytes: typeof info.resources?.memoryTotalBytes === 'number' ? info.resources.memoryTotalBytes : null,
      memoryFreeBytes: typeof info.resources?.memoryFreeBytes === 'number' ? info.resources.memoryFreeBytes : null,
      diskTotalBytes: typeof info.resources?.diskTotalBytes === 'number' ? info.resources.diskTotalBytes : null,
      diskFreeBytes: typeof info.resources?.diskFreeBytes === 'number' ? info.resources.diskFreeBytes : null,
    };
  } catch (err: unknown) {
    console.warn(`[fleet-probe] system info failed for ${machine.handle}:`, err instanceof Error ? err.message : String(err));
    return { healthy: false, probeLatencyMs: performance.now() - started };
  }
}

export function releaseVersionFromProbe(probe: Awaited<ReturnType<typeof probeCustomerVpsRelease>>): string | null {
  const release = probe.release;
  if (!release || typeof release !== 'object' || !('version' in release)) {
    return null;
  }
  const version = (release as { version?: unknown }).version;
  return typeof version === 'string' && version.trim() ? version : null;
}

export async function buildRuntimePickerMachines(
  machines: UserMachineRecord[],
  platformSecret: string,
  dispatcher: Agent,
): Promise<RuntimePickerMachine[]> {
  const enriched = await Promise.allSettled(machines.map(async (machine): Promise<RuntimePickerMachine> => {
    if (machine.status !== 'running' || !platformSecret) {
      return { ...machine, displayVersion: machine.imageVersion ?? 'Version pending' };
    }
    const probe = await probeCustomerVpsRelease(machine, platformSecret, {
      timeoutMs: RUNTIME_PICKER_PROBE_TIMEOUT_MS,
      dispatcher,
    });
    return {
      ...machine,
      displayVersion: releaseVersionFromProbe(probe) ?? machine.imageVersion ?? 'Version pending',
    };
  }));
  return enriched.map((result, index) => {
    if (result.status === 'fulfilled') return result.value;
    return {
      ...machines[index]!,
      displayVersion: machines[index]?.imageVersion ?? 'Version pending',
    };
  });
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as Error & { code?: string }).code;
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
