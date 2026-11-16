import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { describe, expect, it, vi } from 'vitest';
import { createLambdaMicrovmsProvider } from '../../packages/platform/src/substrates/container-provider.js';
import {
  createLambdaMicrovmsApi,
  createLambdaMicrovmsClient,
  type LambdaMicrovmsSender,
} from '../../packages/platform/src/substrates/lambda-microvms-client.js';

function stubbedSender(response: unknown = {}) {
  const send = vi.fn(async () => response);
  return { sender: { send } as unknown as LambdaMicrovmsSender, send };
}

describe('Lambda MicroVMs SDK adapter', () => {
  it.each([
    ['runMicrovm', RunMicrovmCommand, { imageIdentifier: 'img', clientToken: 'k' }],
    ['getMicrovm', GetMicrovmCommand, { microvmIdentifier: 'mvm-1' }],
    ['suspendMicrovm', SuspendMicrovmCommand, { microvmIdentifier: 'mvm-1' }],
    ['resumeMicrovm', ResumeMicrovmCommand, { microvmIdentifier: 'mvm-1' }],
    ['terminateMicrovm', TerminateMicrovmCommand, { microvmIdentifier: 'mvm-1' }],
    ['listMicrovms', ListMicrovmsCommand, { imageIdentifier: 'img', maxResults: 100 }],
    ['createMicrovmAuthToken', CreateMicrovmAuthTokenCommand,
      { microvmIdentifier: 'mvm-1', expirationInMinutes: 30, allowedPorts: [{ port: 4000 }] }],
  ] as const)('%s sends its command with the input and the caller signal', async (method, Command, input) => {
    const { sender, send } = stubbedSender();
    const api = createLambdaMicrovmsApi(sender);
    const options = { abortSignal: AbortSignal.timeout(10_000) };
    await (api[method] as (i: typeof input, o: typeof options) => Promise<unknown>)(input, options);
    const [command, sentOptions] = send.mock.calls[0] as unknown as [{ input: unknown }, unknown];
    expect(command).toBeInstanceOf(Command);
    expect(command.input).toEqual(input);
    expect(sentOptions).toBe(options);
  });

  it('feeds SDK-shaped responses and errors through the provider', async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({
        $metadata: { httpStatusCode: 200 },
        microvmId: 'mvm-1', state: 'RUNNING', endpoint: 'mvm-1.lambda-microvm.eu-west-1.on.aws',
        imageArn: 'img', imageVersion: '1', maximumDurationInSeconds: 28_800, startedAt: new Date('2026-11-10T12:00:00Z'),
      })
      .mockRejectedValueOnce(Object.assign(new Error('not here'), { name: 'ResourceNotFoundException', $fault: 'client' }));
    const provider = createLambdaMicrovmsProvider({
      api: createLambdaMicrovmsApi({ send } as unknown as LambdaMicrovmsSender),
      config: {
        imageIdentifier: 'img', ingressNetworkConnectors: ['in'], egressNetworkConnectors: ['out'],
        gatewayPort: 4000, endpointTokenMinutes: 30, endpointHostSuffix: '.on.aws',
      },
      logError: () => undefined,
    });
    expect(await provider.describe('mvm-1', AbortSignal.timeout(10_000))).toMatchObject({
      unitId: 'mvm-1', state: 'running', endpointHost: 'mvm-1.lambda-microvm.eu-west-1.on.aws',
    });
    expect(await provider.describe('mvm-1', AbortSignal.timeout(10_000))).toBeNull();
  });

  it('builds a client for the configured region with bounded retries and timeouts', async () => {
    const client = createLambdaMicrovmsClient({ region: 'eu-west-1' });
    try {
      expect(await client.config.region()).toBe('eu-west-1');
      expect(await client.config.maxAttempts()).toBe(2);
    } finally {
      client.destroy();
    }
  });
});
