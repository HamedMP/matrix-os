import { describe, expect, it, vi } from 'vitest';
import {
  CONTAINER_UNIT_MAX_LIFETIME_SECONDS,
  ContainerProviderError,
  createLambdaMicrovmsProvider,
  type LambdaMicrovmsApi,
  type LambdaMicrovmsProviderConfig,
} from '../../packages/platform/src/substrates/container-provider.js';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const IMAGE = 'arn:aws:lambda:eu-west-1:000000000000:microvm-image:matrix-runtime';
const ENDPOINT = 'mvm-0123456789abcdef.lambda-microvm.eu-west-1.on.aws';

function config(overrides: Partial<LambdaMicrovmsProviderConfig> = {}): LambdaMicrovmsProviderConfig {
  return {
    imageIdentifier: IMAGE,
    ingressNetworkConnectors: ['arn:aws:lambda:eu-west-1:aws:network-connector:aws-network-connector:HTTP_INGRESS'],
    egressNetworkConnectors: ['arn:aws:lambda:eu-west-1:000000000000:network-connector:matrix-egress'],
    gatewayPort: 4000,
    endpointTokenMinutes: 30,
    endpointHostSuffix: '.on.aws',
    ...overrides,
  };
}

function description(overrides: Record<string, unknown> = {}) {
  return {
    microvmId: 'mvm-0123456789abcdef',
    state: 'PENDING',
    endpoint: ENDPOINT,
    imageArn: IMAGE,
    imageVersion: '3',
    maximumDurationInSeconds: CONTAINER_UNIT_MAX_LIFETIME_SECONDS,
    startedAt: NOW,
    ...overrides,
  };
}

function sdkError(name: string, message = `${name}: arn:aws:lambda:eu-west-1:000000000000:microvm:mvm-1 at 10.0.0.1`): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function fakeApi(overrides: Partial<LambdaMicrovmsApi> = {}): LambdaMicrovmsApi {
  return {
    runMicrovm: vi.fn(async () => description()),
    getMicrovm: vi.fn(async () => description({ state: 'RUNNING' })),
    suspendMicrovm: vi.fn(async () => ({})),
    resumeMicrovm: vi.fn(async () => ({})),
    terminateMicrovm: vi.fn(async () => ({})),
    listMicrovms: vi.fn(async () => ({ items: [] })),
    createMicrovmAuthToken: vi.fn(async () => ({ authToken: { 'X-aws-proxy-auth': 'jwe-token' } })),
    ...overrides,
  };
}

function provider(api: LambdaMicrovmsApi, overrides: Partial<LambdaMicrovmsProviderConfig> = {}) {
  return createLambdaMicrovmsProvider({ api, config: config(overrides), now: () => NOW, logError: () => undefined });
}

const signal = () => AbortSignal.timeout(10_000);

describe('Lambda MicroVMs container provider', () => {
  it('runs a unit from the configured image with an idempotency token and the 8 hour lifetime', async () => {
    const api = fakeApi();
    const s = signal();
    const unit = await provider(api).run({ idempotencyKey: 'run-key-1', bootPayload: '{"v":1}' }, s);

    expect(api.runMicrovm).toHaveBeenCalledWith({
      imageIdentifier: IMAGE,
      ingressNetworkConnectors: config().ingressNetworkConnectors,
      egressNetworkConnectors: config().egressNetworkConnectors,
      maximumDurationInSeconds: 28_800,
      idlePolicy: { maxIdleDurationSeconds: 28_800, autoResumeEnabled: false, suspendedDurationSeconds: 28_800 },
      runHookPayload: '{"v":1}',
      clientToken: 'run-key-1',
    }, { abortSignal: s });
    expect(unit).toEqual({
      unitId: 'mvm-0123456789abcdef',
      state: 'pending',
      endpointHost: ENDPOINT,
      createdAt: NOW,
      expiresAt: new Date(NOW.getTime() + 28_800_000),
    });
  });

  it('leaves idleness to the platform: no provider auto-suspend before the lifetime, no auto-resume', async () => {
    const api = fakeApi();
    await provider(api, { suspendedDurationSeconds: 3_600 }).run({ idempotencyKey: 'k', bootPayload: '{}' }, signal());
    expect(vi.mocked(api.runMicrovm).mock.calls[0]?.[0].idlePolicy).toEqual({
      maxIdleDurationSeconds: 28_800, autoResumeEnabled: false, suspendedDurationSeconds: 3_600,
    });
    expect(() => provider(api, { suspendedDurationSeconds: 0 })).toThrow();
    expect(() => provider(api, { suspendedDurationSeconds: 1.5 })).toThrow();
  });

  it('passes a pinned image version when configured', async () => {
    const api = fakeApi();
    await provider(api, { imageVersion: '7' }).run({ idempotencyKey: 'k', bootPayload: '{}' }, signal());
    expect(vi.mocked(api.runMicrovm).mock.calls[0]?.[0]).toMatchObject({ imageVersion: '7' });
  });

  it('rejects a boot payload over 16 KiB before calling the provider', async () => {
    const api = fakeApi();
    await expect(provider(api).run({ idempotencyKey: 'k', bootPayload: 'x'.repeat(16_385) }, signal()))
      .rejects.toMatchObject({ code: 'invalid_request' });
    expect(api.runMicrovm).not.toHaveBeenCalled();
  });

  it('rejects unsafe unit ids and idempotency keys before calling the provider', async () => {
    const api = fakeApi();
    const p = provider(api);
    await expect(p.resume('mvm-1/../../x', signal())).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(p.run({ idempotencyKey: 'has space', bootPayload: '{}' }, signal())).rejects.toMatchObject({ code: 'invalid_request' });
    expect(api.resumeMicrovm).not.toHaveBeenCalled();
    expect(api.runMicrovm).not.toHaveBeenCalled();
  });

  it('forwards the caller signal on every call', async () => {
    const api = fakeApi();
    const p = provider(api);
    const s = signal();
    await p.suspend('mvm-1', s);
    await p.resume('mvm-1', s);
    await p.terminate('mvm-1', s);
    await p.describe('mvm-1', s);
    await p.list(s);
    await p.mintEndpointCredential('mvm-1', s);
    for (const fn of [api.suspendMicrovm, api.resumeMicrovm, api.terminateMicrovm, api.getMicrovm, api.createMicrovmAuthToken]) {
      expect(vi.mocked(fn).mock.calls[0]?.[1]).toEqual({ abortSignal: s });
    }
    expect(vi.mocked(api.listMicrovms).mock.calls[0]?.[1]).toEqual({ abortSignal: s });
  });

  it('maps an aborted or timed-out call to the timeout code', async () => {
    const controller = new AbortController();
    const api = fakeApi({
      resumeMicrovm: vi.fn(async () => {
        controller.abort(new DOMException('The operation was aborted', 'TimeoutError'));
        throw new DOMException('The operation was aborted', 'AbortError');
      }),
    });
    await expect(provider(api).resume('mvm-1', controller.signal)).rejects.toMatchObject({ code: 'timeout', retryable: true });
  });

  it.each([
    ['ThrottlingException', 'throttled', true],
    ['TooManyRequestsException', 'throttled', true],
    ['InsufficientCapacityException', 'capacity', true],
    ['ServiceQuotaExceededException', 'quota_exceeded', false],
    ['ConflictException', 'conflict', false],
    ['ResourceConflictException', 'conflict', false],
    ['ValidationException', 'invalid_request', false],
    ['InvalidParameterValueException', 'invalid_request', false],
    ['AccessDeniedException', 'access_denied', false],
    ['ResourceNotFoundException', 'not_found', false],
    ['InternalServerException', 'unavailable', true],
    ['ServiceException', 'unavailable', true],
    ['SomethingNew', 'unavailable', true],
  ])('maps %s to %s', async (name, code, retryable) => {
    const api = fakeApi({ resumeMicrovm: vi.fn(async () => { throw sdkError(name); }) });
    const error = await provider(api).resume('mvm-1', signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ContainerProviderError);
    expect(error).toMatchObject({ code, retryable });
  });

  it('never puts provider names, ARNs, or addresses in error messages', async () => {
    const logged: unknown[] = [];
    const api = fakeApi({ runMicrovm: vi.fn(async () => { throw sdkError('InternalServerException'); }) });
    const p = createLambdaMicrovmsProvider({ api, config: config(), now: () => NOW, logError: (...args) => logged.push(args) });
    const error = await p.run({ idempotencyKey: 'k', bootPayload: '{}' }, signal()).catch((e: unknown) => e) as Error;
    expect(error.message).not.toMatch(/arn:|aws|lambda|microvm|10\.0\.0\.1/i);
    expect(JSON.stringify(error)).not.toMatch(/arn:|aws|lambda|microvm/i);
    expect(logged).toHaveLength(1);
  });

  it('describes a missing unit as null and maps states', async () => {
    const api = fakeApi({
      getMicrovm: vi.fn()
        .mockRejectedValueOnce(sdkError('ResourceNotFoundException'))
        .mockResolvedValueOnce(description({ state: 'SUSPENDED' }))
        .mockResolvedValueOnce(description({ state: 'BRAND_NEW_STATE' })),
    });
    const p = provider(api);
    expect(await p.describe('mvm-1', signal())).toBeNull();
    expect((await p.describe('mvm-1', signal()))?.state).toBe('suspended');
    expect((await p.describe('mvm-1', signal()))?.state).toBe('unknown');
  });

  it('drops an endpoint that is not a hostname under the configured suffix', async () => {
    const api = fakeApi({ getMicrovm: vi.fn(async () => description({ endpoint: 'evil.example.com/path?x=1' })) });
    expect((await provider(api).describe('mvm-1', signal()))?.endpointHost).toBeNull();
  });

  it('treats terminating an already-gone unit as success', async () => {
    const api = fakeApi({ terminateMicrovm: vi.fn(async () => { throw sdkError('ResourceNotFoundException'); }) });
    await expect(provider(api).terminate('mvm-1', signal())).resolves.toBeUndefined();
  });

  it('lists only units of the configured image, following pagination', async () => {
    const api = fakeApi({
      listMicrovms: vi.fn()
        .mockResolvedValueOnce({ items: [{ microvmId: 'mvm-a', state: 'RUNNING', imageArn: IMAGE, imageVersion: '3', startedAt: NOW }], nextToken: 'page-2' })
        .mockResolvedValueOnce({ items: [{ microvmId: 'mvm-b', state: 'SUSPENDED', imageArn: IMAGE, imageVersion: '3', startedAt: NOW }] }),
    });
    const units = await provider(api).list(signal());
    expect(units.map(u => [u.unitId, u.state])).toEqual([['mvm-a', 'running'], ['mvm-b', 'suspended']]);
    expect(vi.mocked(api.listMicrovms).mock.calls.map(call => call[0])).toEqual([
      { imageIdentifier: IMAGE, maxResults: 100 },
      { imageIdentifier: IMAGE, maxResults: 100, nextToken: 'page-2' },
    ]);
  });

  it('stops listing at the page cap instead of looping forever', async () => {
    const api = fakeApi({ listMicrovms: vi.fn(async () => ({ items: [], nextToken: 'again' })) });
    await expect(provider(api).list(signal())).rejects.toMatchObject({ code: 'unavailable' });
    expect(vi.mocked(api.listMicrovms).mock.calls.length).toBeLessThanOrEqual(50);
  });

  it('mints an endpoint credential scoped to the gateway port', async () => {
    const api = fakeApi();
    const credential = await provider(api).mintEndpointCredential('mvm-1', signal());
    expect(api.createMicrovmAuthToken).toHaveBeenCalledWith({
      microvmIdentifier: 'mvm-1',
      expirationInMinutes: 30,
      allowedPorts: [{ port: 4000 }],
    }, expect.anything());
    expect(credential).toEqual({
      headers: { 'X-aws-proxy-auth': 'jwe-token', 'X-aws-proxy-port': '4000' },
      expiresAt: new Date(NOW.getTime() + 30 * 60_000),
    });
  });

  it('fails closed when the provider returns no token', async () => {
    const api = fakeApi({ createMicrovmAuthToken: vi.fn(async () => ({ authToken: {} })) });
    await expect(provider(api).mintEndpointCredential('mvm-1', signal())).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses endpoint token lifetimes over 60 minutes', () => {
    expect(() => provider(fakeApi(), { endpointTokenMinutes: 61 })).toThrow();
    expect(() => provider(fakeApi(), { gatewayPort: 70_000 })).toThrow();
  });
});
