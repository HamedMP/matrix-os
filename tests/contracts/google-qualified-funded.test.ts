import { describe, expect, it } from 'vitest';
import { GoogleQualifiedFundedDiscoveryRequestSchema, GoogleQualifiedFundedDiscoveryResponseSchema,
  GoogleQualifiedFundedIssueRequestSchema, GoogleQualifiedFundedIssueResponseSchema,
  GoogleQualifiedFundedCheckRequestSchema, GoogleQualifiedFundedCheckResponseSchema,
  GOOGLE_QUALIFIED_FUNDED_PROTOCOL, GoogleQualifiedFundedCredentialSchema,
  parseGoogleQualifiedFundedCredential } from '../../packages/contracts/src/google-qualified-funded.js';
import { FundedAiRuntimeCredentialIssueRequestSchema, FundedAiRuntimeCredentialIssueResponseSchema,
  FundedAiPolicyCheckRequestSchema, FundedAiAuthorizationRequestSchema } from '../../packages/contracts/src/funded-ai.js';
import { FUNDED_TOKEN_PATTERN } from '../../packages/platform/src/ai-funded-metering-helpers.js';
import { qualifiedLeaseFixture as legacyLeaseFixture, qualifiedRouteFixture } from '../helpers/google-qualified-funded-fixture.js';

function qualifiedLeaseFixture() {
  const lease = legacyLeaseFixture();
  return { ...lease, credential: { ...lease.credential, token: `sk-matrix-google-funded-${lease.credential.tokenId}.${'s'.repeat(43)}` } };
}

describe('separate qualified funded protocol', () => {
  const protocol = 'matrix-google-qualified-funded-v1';
  const discovery = () => ({ protocol, api: 'openai-completions', canonicalModelId: qualifiedRouteFixture().canonicalModelId });
  const binding = () => ({ ...qualifiedRouteFixture(), requestClass: 'interactive' });
  const issue = () => ({ ...discovery(), requestClass: 'interactive', expectedDigest: binding().digest });
  const check = () => ({ ...issue(), credential: qualifiedLeaseFixture().credential.token });
  it('preserves strict legacy shapes and names a separate protocol', () => {
    expect(GOOGLE_QUALIFIED_FUNDED_PROTOCOL).toBe(protocol);
    expect(FundedAiRuntimeCredentialIssueRequestSchema.parse({})).toEqual({ requestClass: 'interactive' });
    expect(FundedAiRuntimeCredentialIssueResponseSchema.parse(legacyLeaseFixture())).toEqual(legacyLeaseFixture());
    expect(FundedAiRuntimeCredentialIssueRequestSchema.safeParse(issue()).success).toBe(false);
    expect(FundedAiPolicyCheckRequestSchema.safeParse(check()).success).toBe(false);
    expect(FundedAiRuntimeCredentialIssueResponseSchema.safeParse({ ...qualifiedLeaseFixture(), binding: binding() }).success).toBe(false);
  });
  it('has a format boundary enforced by actual unchanged legacy schemas and parser', () => {
    const credential = qualifiedLeaseFixture().credential.token; const modelId = qualifiedRouteFixture().canonicalModelId;
    expect(GoogleQualifiedFundedCredentialSchema.parse(credential)).toBe(credential);
    expect(parseGoogleQualifiedFundedCredential(credential)).toEqual({ tokenId: 'token_one' });
    expect(FUNDED_TOKEN_PATTERN.test(credential)).toBe(false);
    expect(FundedAiPolicyCheckRequestSchema.safeParse({ credential, modelId }).success).toBe(false);
    expect(FundedAiAuthorizationRequestSchema.safeParse({ credential, modelId, requestId: 'request_one', maxCostMicrousd: 1 }).success).toBe(false);
    expect(FundedAiRuntimeCredentialIssueResponseSchema.safeParse(qualifiedLeaseFixture()).success).toBe(false);
    expect(GoogleQualifiedFundedCredentialSchema.safeParse(legacyLeaseFixture().credential.token).success).toBe(false);
    expect(parseGoogleQualifiedFundedCredential(legacyLeaseFixture().credential.token)).toBeNull();
    expect(GoogleQualifiedFundedCheckRequestSchema.safeParse({ ...issue(), credential: legacyLeaseFixture().credential.token }).success).toBe(false);
    expect(GoogleQualifiedFundedIssueResponseSchema.safeParse({ protocol, lease: legacyLeaseFixture(), binding: binding() }).success).toBe(false);
    expect(FUNDED_TOKEN_PATTERN.test(legacyLeaseFixture().credential.token)).toBe(true);
  });
  it.each([null, {}, '', 'sk-matrix-google-funded-token_one.short', 'sk-matrix-google-funded-token_one.' + 's'.repeat(42),
    'sk-matrix-google-funded-token_one.' + 's'.repeat(44), 'sk-matrix-google-funded-/bad.' + 's'.repeat(43),
    'sk-matrix-google-funded-token_one.' + 's'.repeat(43) + '\n', 'sk-matrix-google-funded-token_one.' + 's'.repeat(42) + '=',
    'sk-matrix-google-funded-' + 'a'.repeat(81) + '.' + 's'.repeat(43), 'x'.repeat(1000)])('refuses malformed opaque qualified credential %#', value => {
    expect(GoogleQualifiedFundedCredentialSchema.safeParse(value).success).toBe(false);
    expect(parseGoogleQualifiedFundedCredential(value)).toBeNull();
  });
  it.each(['tokenId', 'expiresAt', 'duration', 'extra'])('retains qualified lease integrity check %s', field => {
    const lease: any = qualifiedLeaseFixture();
    if (field === 'tokenId') lease.credential.tokenId = 'different_token';
    if (field === 'expiresAt') lease.credential.expiresAt = lease.credential.issuedAt;
    if (field === 'duration') lease.credential.expiresAt = '2026-10-22T13:00:01.000Z';
    if (field === 'extra') lease.credential.approved = true;
    expect(GoogleQualifiedFundedIssueResponseSchema.safeParse({ protocol, lease, binding: binding() }).success).toBe(false);
  });
  it('accepts exact discovery, issuance and qualified-check payloads', () => {
    expect(GoogleQualifiedFundedDiscoveryRequestSchema.parse(discovery())).toEqual(discovery());
    expect(GoogleQualifiedFundedDiscoveryResponseSchema.parse({ protocol, route: qualifiedRouteFixture() })).toBeTruthy();
    expect(GoogleQualifiedFundedIssueRequestSchema.parse(issue())).toEqual(issue());
    expect(GoogleQualifiedFundedIssueResponseSchema.parse({ protocol, lease: qualifiedLeaseFixture(), binding: binding() })).toBeTruthy();
    expect(GoogleQualifiedFundedCheckRequestSchema.parse(check())).toEqual(check());
    const lease = qualifiedLeaseFixture(); const { token: _token, issuedAt: _issuedAt, ...credentialIdentity } = lease.credential;
    expect(GoogleQualifiedFundedCheckResponseSchema.parse({ protocol, authorization: { contractVersion: 1, authorized: true,
      identity: { ...lease.identity, ...credentialIdentity }, policy: lease.policy }, binding: binding() })).toBeTruthy();
  });
  it.each(['ownerId', 'relayBaseUrl', 'descriptor', 'approved', 'googleOrigin', 'credentialGeneration'])('refuses caller authority field %s', key => {
    for (const [schema, body] of [[GoogleQualifiedFundedDiscoveryRequestSchema, discovery()], [GoogleQualifiedFundedIssueRequestSchema, issue()],
      [GoogleQualifiedFundedCheckRequestSchema, check()]] as const) expect(schema.safeParse({ ...body, [key]: 'forged' }).success).toBe(false);
  });
  it.each(['api', 'model', 'expiry', 'relay', 'class', 'tokenExpiry', 'allowed', 'missingClass', 'version'])('rejects inconsistent response %s', field => {
    const value: any = { protocol, lease: qualifiedLeaseFixture(), binding: binding() };
    if (field === 'api') value.binding.api = 'anthropic-messages';
    if (field === 'model') value.binding.canonicalModelId = '@cf/meta/llama-4-scout-17b-16e-instruct';
    if (field === 'expiry') value.binding.evidenceExpiresAt = '2026-10-24T00:00:00.000Z';
    if (field === 'relay') value.binding.relayBaseUrl = 'https://forged.example.test';
    if (field === 'class') value.binding.requestClass = 'background';
    if (field === 'tokenExpiry') { value.lease.credential.issuedAt = '2026-10-23T11:50:00.000Z'; value.lease.credential.expiresAt = '2026-10-23T12:01:00.000Z'; }
    if (field === 'allowed') value.lease.policy.allowedModelIds = ['anthropic/claude-sonnet-5'];
    if (field === 'missingClass') delete value.lease.requestClass;
    if (field === 'version') value.protocol = 'legacy';
    expect(GoogleQualifiedFundedIssueResponseSchema.safeParse(value).success).toBe(false);
  });
});
