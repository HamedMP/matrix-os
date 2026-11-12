/**
 * Provider-neutral container compute, plus its AWS Lambda MicroVMs implementation.
 *
 * `LambdaMicrovmsApi` is the subset of `@aws-sdk/client-lambda-microvms` this
 * module uses. `lambda-microvms-client.ts` implements it with the SDK client, so
 * the compiler checks these shapes against the SDK's types; tests use fakes.
 */

export const CONTAINER_UNIT_MAX_LIFETIME_SECONDS = 28_800;
/**
 * The provider's largest idle window. Any endpoint traffic, polling included,
 * counts as activity to the provider, so the platform's reaper decides idleness
 * and the provider's own idle suspend is pushed past the unit lifetime.
 */
export const CONTAINER_UNIT_MAX_IDLE_SECONDS = 28_800;
export const CONTAINER_SUSPENDED_DURATION_BOUNDS = { min: 60, max: 28_800, fallback: 28_800 } as const;
const MAX_BOOT_PAYLOAD_BYTES = 16_384;
const MAX_ENDPOINT_TOKEN_MINUTES = 60;
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 50;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A platform-reachable unit endpoint: a plain DNS name inside the provider's suffix. */
export function isContainerEndpointHost(host: string | null | undefined, suffix: string): host is string {
  return typeof host === 'string' && HOSTNAME.test(host) && suffix.startsWith('.') && host.endsWith(suffix);
}

export type ContainerProviderErrorCode =
  | 'not_found' | 'conflict' | 'throttled' | 'capacity' | 'quota_exceeded'
  | 'invalid_request' | 'access_denied' | 'unavailable' | 'timeout';

const RETRYABLE: ReadonlySet<ContainerProviderErrorCode> = new Set(['throttled', 'capacity', 'unavailable', 'timeout']);

/** Carries only a fixed code; the provider's own message stays in server logs. */
export class ContainerProviderError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: ContainerProviderErrorCode) {
    super(`container provider error: ${code}`);
    this.name = 'ContainerProviderError';
    this.retryable = RETRYABLE.has(code);
  }
}

export type ContainerUnitState =
  | 'pending' | 'running' | 'suspending' | 'suspended' | 'terminating' | 'terminated' | 'unknown';

export interface ContainerUnit {
  unitId: string;
  state: ContainerUnitState;
  /** Validated hostname for platform-side requests, or null when absent or malformed. */
  endpointHost: string | null;
  createdAt: Date | null;
  /** When the provider ends the unit regardless of state. */
  expiresAt: Date | null;
}

export interface RunContainerUnitInput {
  /** Same key, same unit: a retried run never creates a second unit. */
  idempotencyKey: string;
  /** Per-unit data delivered after restore, so nothing secret lives in the snapshot. */
  bootPayload: string;
}

export interface EndpointCredential {
  /** Platform-only request headers; never forwarded to clients. */
  headers: Readonly<Record<string, string>>;
  expiresAt: Date;
}

export interface ContainerProvider {
  run(input: RunContainerUnitInput, signal: AbortSignal): Promise<ContainerUnit>;
  suspend(unitId: string, signal: AbortSignal): Promise<void>;
  resume(unitId: string, signal: AbortSignal): Promise<void>;
  /** Idempotent: a unit that is already gone counts as terminated. */
  terminate(unitId: string, signal: AbortSignal): Promise<void>;
  /** Null when the provider no longer knows the unit. */
  describe(unitId: string, signal: AbortSignal): Promise<ContainerUnit | null>;
  list(signal: AbortSignal): Promise<ContainerUnit[]>;
  mintEndpointCredential(unitId: string, signal: AbortSignal): Promise<EndpointCredential>;
}

interface CallOptions { abortSignal: AbortSignal }

interface MicrovmDescription {
  microvmId?: string;
  state?: string;
  endpoint?: string;
  maximumDurationInSeconds?: number;
  startedAt?: Date;
}

interface MicrovmItem {
  microvmId?: string;
  state?: string;
  imageArn?: string;
  imageVersion?: string;
  startedAt?: Date;
}

export interface LambdaMicrovmsApi {
  runMicrovm(input: {
    imageIdentifier: string;
    imageVersion?: string;
    ingressNetworkConnectors?: string[];
    egressNetworkConnectors?: string[];
    maximumDurationInSeconds?: number;
    idlePolicy?: { maxIdleDurationSeconds: number; suspendedDurationSeconds: number; autoResumeEnabled: boolean };
    runHookPayload?: string;
    clientToken?: string;
  }, options: CallOptions): Promise<MicrovmDescription>;
  getMicrovm(input: { microvmIdentifier: string }, options: CallOptions): Promise<MicrovmDescription>;
  suspendMicrovm(input: { microvmIdentifier: string }, options: CallOptions): Promise<unknown>;
  resumeMicrovm(input: { microvmIdentifier: string }, options: CallOptions): Promise<unknown>;
  terminateMicrovm(input: { microvmIdentifier: string }, options: CallOptions): Promise<unknown>;
  listMicrovms(input: { imageIdentifier?: string; maxResults?: number; nextToken?: string }, options: CallOptions):
    Promise<{ items?: MicrovmItem[]; nextToken?: string }>;
  createMicrovmAuthToken(input: {
    microvmIdentifier: string;
    expirationInMinutes: number;
    allowedPorts: Array<{ port: number }>;
  }, options: CallOptions): Promise<{ authToken?: Record<string, string> }>;
}

export interface LambdaMicrovmsProviderConfig {
  imageIdentifier: string;
  imageVersion?: string;
  ingressNetworkConnectors: string[];
  egressNetworkConnectors: string[];
  /** Port the gateway listens on inside the unit; the only port a minted token opens. */
  gatewayPort: number;
  endpointTokenMinutes: number;
  /** Endpoints outside this DNS suffix are treated as absent. */
  endpointHostSuffix: string;
  /** How long a suspended unit, and so its disk, is kept before the provider terminates it. */
  suspendedDurationSeconds?: number;
}

export interface LambdaMicrovmsProviderDeps {
  api: LambdaMicrovmsApi;
  config: LambdaMicrovmsProviderConfig;
  now?: () => Date;
  logError?: (message: string, detail: { operation: string; name: string }) => void;
}

const STATES: Record<string, ContainerUnitState> = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUSPENDING: 'suspending',
  SUSPENDED: 'suspended',
  TERMINATING: 'terminating',
  TERMINATED: 'terminated',
};

const ERROR_CODES: Record<string, ContainerProviderErrorCode> = {
  ThrottlingException: 'throttled',
  TooManyRequestsException: 'throttled',
  InsufficientCapacityException: 'capacity',
  ServiceQuotaExceededException: 'quota_exceeded',
  ConflictException: 'conflict',
  ResourceConflictException: 'conflict',
  ValidationException: 'invalid_request',
  InvalidParameterValueException: 'invalid_request',
  AccessDeniedException: 'access_denied',
  ResourceNotFoundException: 'not_found',
};

function assertConfig(config: LambdaMicrovmsProviderConfig): void {
  if (!config.imageIdentifier) throw new Error('Container provider image is required');
  if (!Number.isInteger(config.gatewayPort) || config.gatewayPort < 1 || config.gatewayPort > 65_535) {
    throw new Error('Container provider gateway port is invalid');
  }
  if (!Number.isInteger(config.endpointTokenMinutes) || config.endpointTokenMinutes < 1
    || config.endpointTokenMinutes > MAX_ENDPOINT_TOKEN_MINUTES) {
    throw new Error('Container provider endpoint token lifetime must be 1 to 60 minutes');
  }
  if (!config.endpointHostSuffix.startsWith('.')) throw new Error('Container provider endpoint suffix must start with a dot');
  const suspended = config.suspendedDurationSeconds ?? CONTAINER_SUSPENDED_DURATION_BOUNDS.fallback;
  if (!Number.isInteger(suspended) || suspended < CONTAINER_SUSPENDED_DURATION_BOUNDS.min
    || suspended > CONTAINER_SUSPENDED_DURATION_BOUNDS.max) {
    throw new Error('Container provider suspended duration is out of range');
  }
}

export function createLambdaMicrovmsProvider(deps: LambdaMicrovmsProviderDeps): ContainerProvider {
  const { api, config } = deps;
  assertConfig(config);
  const now = deps.now ?? (() => new Date());
  const logError = deps.logError ?? ((message, detail) => console.error(message, detail));

  function validId(value: string): string {
    if (!SAFE_ID.test(value)) throw new ContainerProviderError('invalid_request');
    return value;
  }

  function endpointHost(raw: string | undefined): string | null {
    if (!raw) return null;
    const host = raw.replace(/^https:\/\//, '').toLowerCase();
    return isContainerEndpointHost(host, config.endpointHostSuffix) ? host : null;
  }

  function toUnit(raw: MicrovmDescription | MicrovmItem, lifetimeSeconds?: number): ContainerUnit | null {
    if (!raw.microvmId || !SAFE_ID.test(raw.microvmId)) return null;
    const createdAt = raw.startedAt instanceof Date ? raw.startedAt : null;
    const lifetime = lifetimeSeconds ?? CONTAINER_UNIT_MAX_LIFETIME_SECONDS;
    return {
      unitId: raw.microvmId,
      state: STATES[raw.state ?? ''] ?? 'unknown',
      endpointHost: 'endpoint' in raw ? endpointHost(raw.endpoint) : null,
      createdAt,
      expiresAt: createdAt ? new Date(createdAt.getTime() + lifetime * 1000) : null,
    };
  }

  async function call<T>(operation: string, signal: AbortSignal, work: (options: CallOptions) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new ContainerProviderError('timeout');
    try {
      return await work({ abortSignal: signal });
    } catch (error: unknown) {
      if (error instanceof ContainerProviderError) throw error;
      const name = error instanceof Error ? error.name : 'Unknown';
      const code: ContainerProviderErrorCode = signal.aborted || name === 'AbortError' || name === 'TimeoutError'
        ? 'timeout'
        : ERROR_CODES[name] ?? 'unavailable';
      if (code !== 'not_found') {
        logError('[container-provider] call failed', { operation, name: name.slice(0, 80) });
      }
      throw new ContainerProviderError(code);
    }
  }

  function requireUnit(unit: ContainerUnit | null): ContainerUnit {
    if (!unit) throw new ContainerProviderError('unavailable');
    return unit;
  }

  return {
    async run(input, signal) {
      validId(input.idempotencyKey);
      if (Buffer.byteLength(input.bootPayload, 'utf8') > MAX_BOOT_PAYLOAD_BYTES) {
        throw new ContainerProviderError('invalid_request');
      }
      const raw = await call('run', signal, options => api.runMicrovm({
        imageIdentifier: config.imageIdentifier,
        ...(config.imageVersion ? { imageVersion: config.imageVersion } : {}),
        ingressNetworkConnectors: config.ingressNetworkConnectors,
        egressNetworkConnectors: config.egressNetworkConnectors,
        maximumDurationInSeconds: CONTAINER_UNIT_MAX_LIFETIME_SECONDS,
        idlePolicy: {
          maxIdleDurationSeconds: CONTAINER_UNIT_MAX_IDLE_SECONDS,
          autoResumeEnabled: false,
          suspendedDurationSeconds: config.suspendedDurationSeconds ?? CONTAINER_SUSPENDED_DURATION_BOUNDS.fallback,
        },
        runHookPayload: input.bootPayload,
        clientToken: input.idempotencyKey,
      }, options));
      return requireUnit(toUnit(raw, raw.maximumDurationInSeconds));
    },
    async suspend(unitId, signal) {
      const id = validId(unitId);
      await call('suspend', signal, options => api.suspendMicrovm({ microvmIdentifier: id }, options));
    },
    async resume(unitId, signal) {
      const id = validId(unitId);
      await call('resume', signal, options => api.resumeMicrovm({ microvmIdentifier: id }, options));
    },
    async terminate(unitId, signal) {
      const id = validId(unitId);
      try {
        await call('terminate', signal, options => api.terminateMicrovm({ microvmIdentifier: id }, options));
      } catch (error: unknown) {
        if (error instanceof ContainerProviderError && error.code === 'not_found') return;
        throw error;
      }
    },
    async describe(unitId, signal) {
      const id = validId(unitId);
      try {
        const raw = await call('describe', signal, options => api.getMicrovm({ microvmIdentifier: id }, options));
        return toUnit(raw, raw.maximumDurationInSeconds);
      } catch (error: unknown) {
        if (error instanceof ContainerProviderError && error.code === 'not_found') return null;
        throw error;
      }
    },
    async list(signal) {
      const units: ContainerUnit[] = [];
      let nextToken: string | undefined;
      for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
        const token = nextToken;
        const result = await call('list', signal, options => api.listMicrovms({
          imageIdentifier: config.imageIdentifier,
          maxResults: LIST_PAGE_SIZE,
          ...(token ? { nextToken: token } : {}),
        }, options));
        for (const item of result.items ?? []) {
          const unit = toUnit(item);
          if (unit) units.push(unit);
        }
        if (!result.nextToken) return units;
        nextToken = result.nextToken;
      }
      logError('[container-provider] list exceeded page cap', { operation: 'list', name: 'PageCap' });
      throw new ContainerProviderError('unavailable');
    },
    async mintEndpointCredential(unitId, signal) {
      const id = validId(unitId);
      const issuedAt = now();
      const result = await call('mint', signal, options => api.createMicrovmAuthToken({
        microvmIdentifier: id,
        expirationInMinutes: config.endpointTokenMinutes,
        allowedPorts: [{ port: config.gatewayPort }],
      }, options));
      const entries = Object.entries(result.authToken ?? {}).filter(([key, value]) => key && value);
      if (entries.length === 0) throw new ContainerProviderError('unavailable');
      return {
        headers: { ...Object.fromEntries(entries), 'X-aws-proxy-port': String(config.gatewayPort) },
        expiresAt: new Date(issuedAt.getTime() + config.endpointTokenMinutes * 60_000),
      };
    },
  };
}
