import { WebSocket } from 'ws';
import type { Dispatcher } from 'undici';
import { z } from 'zod/v4';
import { buildPlatformVerificationToken } from './platform-token.js';
import { shouldVerifyCustomerVpsTls } from './customer-vps-tls.js';

// Three probes plus the stability gaps must remain comfortably inside the
// host launcher's 10-second registration request timeout.
const STARTUP_PROBE_TIMEOUT_MS = 1_500;
const MAX_PROBE_RESPONSE_BYTES = 8 * 1024;

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
