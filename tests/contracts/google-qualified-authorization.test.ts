import { describe, expect, it } from 'vitest';
import { GoogleQualifiedFundedAuthorizationRequestSchema as Authorization, GoogleQualifiedFundedDispatchCheckRequestSchema as Dispatch } from '../../packages/contracts/src/google-qualified-authorization.js';
import { FundedAiAuthorizationRequestSchema } from '../../packages/contracts/src/funded-ai.js';
import { qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';
const selector = () => ({ protocol: 'matrix-google-qualified-funded-v1', credential: `sk-matrix-google-funded-token_one.${'s'.repeat(43)}`,
  api: 'openai-completions', canonicalModelId: qualifiedRouteFixture().canonicalModelId, expectedDigest: qualifiedRouteFixture().digest });
const request = () => ({ ...selector(), requestId: 'request_one', maxCostMicrousd: 100, billingMode: 'usage' });
describe('qualified reservation and dispatch contracts', () => {
  it('accepts exact separate requests; class is derived by server', () => {
    expect(Authorization.parse(request())).toEqual(request()); expect(Dispatch.parse(selector())).toEqual(selector());
    expect(FundedAiAuthorizationRequestSchema.safeParse(request()).success).toBe(false);
  });
  it.each(['requestClass', 'ownerId', 'descriptor', 'relayBaseUrl', 'approved', 'googleOrigin', 'jevPricingVersion', 'modelId'])('refuses caller authority or legacy field %s', field => {
    expect(Authorization.safeParse({ ...request(), [field]: 'forged' }).success).toBe(false);
    expect(Dispatch.safeParse({ ...selector(), [field]: 'forged' }).success).toBe(false);
  });
  it.each([{ credential: `sk-matrix-funded-token_one.${'s'.repeat(43)}` }, { api: 'anthropic-messages' }, { expectedDigest: 'bad' },
    { billingMode: 'hold' }, { maxCostMicrousd: 0 }, { requestId: '../bad' }])('fails closed on malformed/downgrade %#', patch => {
    expect(Authorization.safeParse({ ...request(), ...patch }).success).toBe(false);
  });
});
