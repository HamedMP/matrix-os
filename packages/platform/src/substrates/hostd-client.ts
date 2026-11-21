import { rootCertificates } from 'node:tls';
import { Agent, request, type Dispatcher } from 'undici';
import type { z } from 'zod/v4';
import {
  HOSTD_MAX_RESUME_BUDGET_MS,
  HostdCapacityResponseSchema,
  HostdCreateVmRequestSchema,
  HostdCreateVmResponseSchema,
  HostdErrorBodySchema,
  HostdListVmsResponseSchema,
  HostdPolicyRequestSchema,
  HostdResumeRequestSchema,
  HostdResumeResponseSchema,
  HostdStopResponseSchema,
  HostdSuspendRequestSchema,
  HostdSuspendResponseSchema,
  HostdVmIdSchema,
  HostdVmSchema,
  type HostdCapacityResponse,
  type HostdCreateVmRequest,
  type HostdCreateVmResponse,
  type HostdErrorCode,
  type HostdPolicyRequest,
  type HostdResumeResponse,
  type HostdStopResponse,
  type HostdSuspendResponse,
  type HostdVm,
} from '@matrix-os/contracts';
import type { MetalHost } from './metal-hosts-repository.js';

/**
 * Client for the hostd API on a metal host (spec 2691, ENG-520). Every call is
 * bounded by a timeout, reads at most 64 KiB of response, and parses the
 * answer with the shared contract. Failures are typed HostdError codes; hostd
 * error text, the token, and transport details never reach the message.
 */

export const HOSTD_API_TIMEOUT_MS = 10_000;
export const HOSTD_CREATE_TIMEOUT_MS = 120_000;
export const HOSTD_RESUME_GRACE_MS = 2_000;
/**
 * A fenced suspend can wait in hostd's per-VM queue for up to 120 s behind a
 * create (15 s behind a resume) before hostd answers 202, so the client waits
 * longer than that.
 */
export const HOSTD_SUSPEND_TIMEOUT_MS = 140_000;
export const HOSTD_RESPONSE_LIMIT_BYTES = 64 * 1024;
const MIN_TOKEN_LENGTH = 32;

export type HostdClientErrorCode = HostdErrorCode | 'timeout' | 'unreachable' | 'invalid_response';

export class HostdError extends Error {
  readonly code: HostdClientErrorCode;

  constructor(code: HostdClientErrorCode, options?: { cause?: unknown }) {
    super(`hostd request failed: ${code}`, options);
    this.name = 'HostdError';
    this.code = code;
  }
}

export interface HostdClientOptions {
  /** TLS dispatcher; build it with createHostdDispatcher. Defaults to undici's global dispatcher (system roots). */
  dispatcher?: Dispatcher;
  timeoutMs?: number;
  createTimeoutMs?: number;
  resumeGraceMs?: number;
  suspendTimeoutMs?: number;
}

/** Fences a resume or suspend to the platform's generation of the VM; hostd answers 409 (`conflict`) on a mismatch. */
export interface HostdFence {
  expectedGeneration: number;
}

export interface HostdClient {
  createVm(spec: HostdCreateVmRequest, signal?: AbortSignal): Promise<HostdCreateVmResponse>;
  listVms(signal?: AbortSignal): Promise<HostdVm[]>;
  getVm(vmId: string, signal?: AbortSignal): Promise<HostdVm>;
  resume(vmId: string, budgetMs: number, signal?: AbortSignal, fence?: HostdFence): Promise<HostdResumeResponse>;
  suspend(vmId: string, signal?: AbortSignal, fence?: HostdFence): Promise<HostdSuspendResponse>;
  stop(vmId: string, signal?: AbortSignal): Promise<HostdStopResponse>;
  destroy(vmId: string, signal?: AbortSignal): Promise<void>;
  setPolicy(vmId: string, policy: HostdPolicyRequest, signal?: AbortSignal): Promise<HostdVm>;
  capacity(signal?: AbortSignal): Promise<HostdCapacityResponse>;
}

/**
 * A dispatcher that verifies hostd and ingress certificates against the system
 * roots plus, when given, one extra CA (self-signed staging hosts).
 */
export function createHostdDispatcher(extraCaPem?: string): Dispatcher {
  return new Agent({
    connect: extraCaPem ? { ca: [...rootCertificates, extraCaPem] } : {},
    connections: 32,
    keepAliveTimeout: 10_000,
  });
}

const STATUS_CODES: Record<number, HostdErrorCode> = {
  400: 'bad_request',
  401: 'unauthorized',
  404: 'not_found',
  409: 'conflict',
  413: 'bad_request',
  503: 'busy',
  507: 'pool_full',
};

async function readBounded(body: Dispatcher.ResponseData['body']): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > HOSTD_RESPONSE_LIMIT_BYTES) {
      body.destroy();
      throw new HostdError('invalid_response');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function vmPath(vmId: string, suffix = ''): string {
  const parsed = HostdVmIdSchema.safeParse(vmId);
  if (!parsed.success) throw new HostdError('bad_request');
  return `/v1/vms/${parsed.data}${suffix}`;
}

export function createHostdClient(
  host: Pick<MetalHost, 'id' | 'apiUrl'>,
  token: string,
  options: HostdClientOptions = {},
): HostdClient {
  if (token.length < MIN_TOKEN_LENGTH) throw new Error('hostd API token is too short');
  const timeoutMs = options.timeoutMs ?? HOSTD_API_TIMEOUT_MS;
  const createTimeoutMs = options.createTimeoutMs ?? HOSTD_CREATE_TIMEOUT_MS;
  const resumeGraceMs = options.resumeGraceMs ?? HOSTD_RESUME_GRACE_MS;
  const suspendTimeoutMs = options.suspendTimeoutMs ?? HOSTD_SUSPEND_TIMEOUT_MS;

  async function call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    schema: z.ZodType<T> | null,
    init: { body?: unknown; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<T> {
    const callerSignal = init.signal;
    callerSignal?.throwIfAborted();
    const timeout = AbortSignal.timeout(init.timeoutMs ?? timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    let status: number;
    let text: string;
    try {
      const response = await request(new URL(path, host.apiUrl), {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal,
        ...(options.dispatcher ? { dispatcher: options.dispatcher } : {}),
      });
      status = response.statusCode;
      text = await readBounded(response.body);
    } catch (error: unknown) {
      if (callerSignal?.aborted) throw callerSignal.reason;
      if (error instanceof HostdError) throw error;
      if (timeout.aborted) throw new HostdError('timeout', { cause: error });
      throw new HostdError('unreachable', { cause: error });
    }

    if (status < 200 || status >= 300) {
      const body = HostdErrorBodySchema.safeParse(parseJson(text));
      throw new HostdError(body.success ? body.data.error : STATUS_CODES[status] ?? 'internal');
    }
    if (schema === null) return undefined as T;
    const parsed = schema.safeParse(parseJson(text));
    if (!parsed.success) throw new HostdError('invalid_response');
    return parsed.data;
  }

  return {
    async createVm(spec, signal) {
      const body = HostdCreateVmRequestSchema.safeParse(spec);
      if (!body.success) throw new HostdError('bad_request');
      return call('POST', '/v1/vms', HostdCreateVmResponseSchema, { body: body.data, timeoutMs: createTimeoutMs, signal });
    },
    async listVms(signal) {
      return (await call('GET', '/v1/vms', HostdListVmsResponseSchema, { signal })).vms;
    },
    async getVm(vmId, signal) {
      return call('GET', vmPath(vmId), HostdVmSchema, { signal });
    },
    async resume(vmId, budgetMs, signal, fence) {
      const path = vmPath(vmId, '/resume');
      const body = HostdResumeRequestSchema.safeParse(fence ? { budgetMs, expectedGeneration: fence.expectedGeneration } : { budgetMs });
      if (!body.success) throw new HostdError('bad_request');
      return call('POST', path, HostdResumeResponseSchema, {
        body: body.data,
        timeoutMs: Math.min(body.data.budgetMs, HOSTD_MAX_RESUME_BUDGET_MS) + resumeGraceMs,
        signal,
      });
    },
    async suspend(vmId, signal, fence) {
      const path = vmPath(vmId, '/suspend');
      if (!fence) return call('POST', path, HostdSuspendResponseSchema, { signal, timeoutMs: suspendTimeoutMs });
      const body = HostdSuspendRequestSchema.safeParse({ expectedGeneration: fence.expectedGeneration });
      if (!body.success) throw new HostdError('bad_request');
      return call('POST', path, HostdSuspendResponseSchema, { body: body.data, signal, timeoutMs: suspendTimeoutMs });
    },
    async stop(vmId, signal) {
      return call('POST', vmPath(vmId, '/stop'), HostdStopResponseSchema, { signal });
    },
    async destroy(vmId, signal) {
      await call('DELETE', vmPath(vmId), null, { signal });
    },
    async setPolicy(vmId, policy, signal) {
      const path = vmPath(vmId, '/policy');
      const body = HostdPolicyRequestSchema.safeParse(policy);
      if (!body.success) throw new HostdError('bad_request');
      return call('PUT', path, HostdVmSchema, { body: body.data, signal });
    },
    async capacity(signal) {
      return call('GET', '/v1/capacity', HostdCapacityResponseSchema, { signal });
    },
  };
}
