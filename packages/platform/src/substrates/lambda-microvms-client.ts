import {
  CreateMicrovmAuthTokenCommand,
  GetMicrovmCommand,
  LambdaMicrovmsClient,
  ListMicrovmsCommand,
  ResumeMicrovmCommand,
  RunMicrovmCommand,
  SuspendMicrovmCommand,
  TerminateMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import type { LambdaMicrovmsApi } from './container-provider.js';

const CONNECTION_TIMEOUT_MS = 3_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

/** The subset of the SDK client this adapter uses, so tests can stub `send`. */
export type LambdaMicrovmsSender = Pick<LambdaMicrovmsClient, 'send'>;

/**
 * Forwards each call to the SDK unchanged. Assigning the SDK's outputs to
 * `LambdaMicrovmsApi` is what checks the hand-written shapes against the
 * SDK's own types.
 */
export function createLambdaMicrovmsApi(client: LambdaMicrovmsSender): LambdaMicrovmsApi {
  return {
    runMicrovm: (input, options) => client.send(new RunMicrovmCommand(input), options),
    getMicrovm: (input, options) => client.send(new GetMicrovmCommand(input), options),
    suspendMicrovm: (input, options) => client.send(new SuspendMicrovmCommand(input), options),
    resumeMicrovm: (input, options) => client.send(new ResumeMicrovmCommand(input), options),
    terminateMicrovm: (input, options) => client.send(new TerminateMicrovmCommand(input), options),
    listMicrovms: (input, options) => client.send(new ListMicrovmsCommand(input), options),
    createMicrovmAuthToken: (input, options) => client.send(new CreateMicrovmAuthTokenCommand(input), options),
  };
}

/**
 * Credentials come from the SDK's default provider chain (for the platform,
 * web-identity federation); nothing here reads, logs, or returns them.
 */
export function createLambdaMicrovmsClient(options: { region: string }): LambdaMicrovmsClient {
  return new LambdaMicrovmsClient({
    region: options.region,
    maxAttempts: MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: CONNECTION_TIMEOUT_MS, requestTimeout: REQUEST_TIMEOUT_MS },
  });
}
