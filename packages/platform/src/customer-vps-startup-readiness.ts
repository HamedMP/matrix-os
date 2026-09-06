import { WebSocket } from 'ws';
import type { Dispatcher } from 'undici';
import { z } from 'zod/v4';
import { buildPlatformVerificationToken } from './platform-token.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';
import { CustomerVpsError } from './customer-vps-errors.js';
import type { HetznerClient } from './customer-vps-hetzner.js';

// Three probes plus the stability gaps remain below the host launcher's
// 30-second registration request timeout, including recovery's bounded
// provider address verification.
const STARTUP_PROBE_TIMEOUT_MS = 1_500;
const MAX_PROBE_RESPONSE_BYTES = 8 * 1024;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const HealthResponseSchema = z.object({
  status: z.literal('ok'),
});

const SystemInfoResponseSchema = z.object({
  release: z.object({
    version: z.string().min(1).max(128),
  }),
});

const TerminalReadinessFrameSchema = z.object({
  type: z.literal('ready'),
  terminalWebSocket: z.literal('ok'),
}).strict();

export type StartupReadinessCheck = 'health' | 'system_info' | 'terminal_websocket';

export interface CustomerVpsStartupReadinessInput {
  machineId: string;
  handle: string;
  publicIPv4: string;
  expectedVersion: string;
  platformSecret: string;
}

export interface CustomerVpsStartupReadinessResult {
  ready: boolean;
  failing: StartupReadinessCheck[];
}

interface TerminalWebSocketProbeInput {
  url: string;
  authorization: string;
  timeoutMs: number;
  rejectUnauthorized: boolean;
}

interface CustomerVpsStartupReadinessOptions {
  dispatcher: Dispatcher;
  fetch?: typeof fetch;
  probeTerminalWebSocket?: (input: TerminalWebSocketProbeInput) => Promise<boolean>;
  tlsRejectUnauthorized?: boolean;
}

export interface CustomerVpsStartupReadinessGateOptions {
  dispatcher?: Dispatcher;
  probe?: (input: CustomerVpsStartupReadinessInput) => Promise<CustomerVpsStartupReadinessResult>;
  intervalMs?: number;
}

export interface CustomerVpsRegistrationReadinessAddressInput {
  machineId: string;
  status: 'provisioning' | 'recovering';
  hetznerServerId: number;
  storedPublicIPv4: string | null;
  callbackPublicIPv4: string;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > MAX_PROBE_RESPONSE_BYTES) {
        await reader.cancel();
        return undefined;
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body) as unknown;
  } catch (err: unknown) {
    if (!(err instanceof SyntaxError) && !(err instanceof DOMException) && !(err instanceof TypeError)) {
      console.warn('[customer-vps-readiness] unexpected bounded response read failure');
    }
    return undefined;
  } finally {
    reader.releaseLock();
  }
}

async function fetchProbeJson(
  url: string,
  authorization: string,
  dispatcher: Dispatcher,
  fetchImpl: typeof fetch,
): Promise<unknown> {
  try {
    const response = await fetchImpl(url, {
      headers: { authorization },
      redirect: 'error',
      signal: AbortSignal.timeout(STARTUP_PROBE_TIMEOUT_MS),
      dispatcher,
    } as RequestInit & { dispatcher: Dispatcher });
    if (!response.ok) return undefined;
    return await readBoundedJson(response);
  } catch (err: unknown) {
    if (!(err instanceof DOMException) && !(err instanceof TypeError)) {
      console.warn('[customer-vps-readiness] unexpected HTTP probe failure');
    }
    return undefined;
  }
}

export function probeTerminalWebSocketReadiness(input: TerminalWebSocketProbeInput): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new WebSocket(input.url, {
      headers: { authorization: input.authorization },
      handshakeTimeout: input.timeoutMs,
      maxPayload: MAX_PROBE_RESPONSE_BYTES,
      rejectUnauthorized: input.rejectUnauthorized,
    });

    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
      else if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      resolve(ready);
    };

    const timer = setTimeout(() => finish(false), input.timeoutMs);
    timer.unref();
    socket.once('message', (data) => {
      const frame = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(data))
          : Buffer.from(data);
      if (frame.byteLength > MAX_PROBE_RESPONSE_BYTES) {
        finish(false);
        return;
      }
      try {
        const parsed = TerminalReadinessFrameSchema.safeParse(JSON.parse(frame.toString()));
        finish(parsed.success);
      } catch (err: unknown) {
        if (!(err instanceof SyntaxError)) {
          console.warn('[customer-vps-readiness] unexpected terminal readiness frame failure');
        }
        finish(false);
      }
    });
    socket.once('error', () => finish(false));
    socket.once('close', () => finish(false));
  });
}

export async function probeCustomerVpsStartupReadiness(
  input: CustomerVpsStartupReadinessInput,
  options: CustomerVpsStartupReadinessOptions,
): Promise<CustomerVpsStartupReadinessResult> {
  const fetchImpl = options.fetch ?? fetch;
  const terminalProbe = options.probeTerminalWebSocket ?? probeTerminalWebSocketReadiness;
  const authorization = `Bearer ${buildPlatformVerificationToken(input.handle, input.platformSecret)}`;
  const baseUrl = `https://${input.publicIPv4}:443`;
  const [healthBody, systemInfoBody, terminalReady] = await Promise.all([
    fetchProbeJson(`${baseUrl}/health`, authorization, options.dispatcher, fetchImpl),
    fetchProbeJson(`${baseUrl}/api/system/info`, authorization, options.dispatcher, fetchImpl),
    terminalProbe({
      url: `wss://${input.publicIPv4}:443/ws/terminal/readiness`,
      authorization,
      timeoutMs: STARTUP_PROBE_TIMEOUT_MS,
      rejectUnauthorized: options.tlsRejectUnauthorized ?? shouldVerifyCustomerVpsTls(),
    }),
  ]);

  const failing: StartupReadinessCheck[] = [];
  if (!HealthResponseSchema.safeParse(healthBody).success) failing.push('health');
  const systemInfo = SystemInfoResponseSchema.safeParse(systemInfoBody);
  if (!systemInfo.success || systemInfo.data.release.version !== input.expectedVersion) {
    failing.push('system_info');
  }
  if (!terminalReady) failing.push('terminal_websocket');
  return { ready: failing.length === 0, failing };
}

export function createCustomerVpsStartupReadinessGate(
  options: CustomerVpsStartupReadinessGateOptions,
): (input: CustomerVpsStartupReadinessInput) => Promise<void> {
  const intervalMs = Math.min(5_000, Math.max(0, options.intervalMs ?? 500));
  const dispatcher = options.dispatcher;
  const probe = options.probe
    ?? (dispatcher
      ? (input: CustomerVpsStartupReadinessInput) => probeCustomerVpsStartupReadiness(input, {
          dispatcher,
        })
      : undefined);

  return async (input: CustomerVpsStartupReadinessInput): Promise<void> => {
    if (!probe) return;
    for (let success = 0; success < 3; success += 1) {
      let result: CustomerVpsStartupReadinessResult;
      try {
        result = await probe(input);
      } catch (err: unknown) {
        const errorName = err instanceof Error ? err.name : 'UnknownError';
        console.warn(
          `[customer-vps] startup readiness probe unavailable machineId=${input.machineId} error=${errorName}`,
        );
        throw new CustomerVpsError(425, 'runtime_not_ready', 'Computer is still starting');
      }
      if (!result.ready) {
        console.info(
          `[customer-vps] startup readiness pending machineId=${input.machineId} checks=${result.failing.join(',')}`,
        );
        throw new CustomerVpsError(425, 'runtime_not_ready', 'Computer is still starting');
      }
      if (success < 2 && intervalMs > 0) await sleep(intervalMs);
    }
  };
}

export async function resolveCustomerVpsRegistrationReadinessAddress(
  input: CustomerVpsRegistrationReadinessAddressInput,
  hetzner: Pick<HetznerClient, 'getServer'>,
): Promise<string> {
  if (input.status === 'provisioning') {
    // Provisioning persists the provider-returned address before bootstrap,
    // so an authenticated callback still cannot redirect platform probes.
    if (!input.storedPublicIPv4 || input.storedPublicIPv4 !== input.callbackPublicIPv4) {
      throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
    }
    return input.callbackPublicIPv4;
  }

  // Recovery deliberately keeps public_ipv4 pointed at the routable
  // predecessor until cutover. Resolve the replacement by its already
  // persisted provider id before sending the platform bearer token to it.
  let replacement;
  try {
    replacement = await hetzner.getServer(input.hetznerServerId);
  } catch (err: unknown) {
    console.warn(
      `[customer-vps] recovery registration address verification unavailable machineId=${input.machineId} error=${err instanceof Error ? err.name : 'UnknownError'}`,
    );
    throw new CustomerVpsError(425, 'runtime_not_ready', 'Computer is still starting');
  }
  if (!replacement
    || replacement.id !== input.hetznerServerId
    || replacement.publicIPv4 !== input.callbackPublicIPv4) {
    throw new CustomerVpsError(401, 'registration_rejected', 'Registration rejected');
  }
  return input.callbackPublicIPv4;
}
