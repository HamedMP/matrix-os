import { describe, expect, it } from 'vitest';
import {
  resolveGitHubIntegrationConfig,
  resolvePlatformIntegrationConfig,
} from '../../packages/platform/src/integration-config.js';

describe('platform integration config', () => {
  it('enables Pipedream integrations with the Cloud Run platform database URL', () => {
    const config = resolvePlatformIntegrationConfig({
      PLATFORM_DATABASE_URL: 'postgres://matrixos_platform:secret@db.example.com/matrixos_platform',
      PIPEDREAM_CLIENT_ID: 'client-id',
      PIPEDREAM_CLIENT_SECRET: 'client-secret',
      PIPEDREAM_PROJECT_ID: 'project-id',
      PIPEDREAM_ENVIRONMENT: 'production',
    }, 'postgres://matrixos_platform:secret@db.example.com/matrixos_platform');

    expect(config).toMatchObject({
      platformDatabaseUrl: 'postgres://matrixos_platform:secret@db.example.com/matrixos_platform',
      pipedreamClientId: 'client-id',
      pipedreamClientSecret: 'client-secret',
      pipedreamProjectId: 'project-id',
      pipedreamEnvironment: 'production',
    });
  });

  it('keeps integrations disabled until all required Pipedream credentials exist', () => {
    expect(resolvePlatformIntegrationConfig({
      PIPEDREAM_CLIENT_ID: 'client-id',
      PIPEDREAM_PROJECT_ID: 'project-id',
    }, 'postgres://db.example.com/matrixos_platform')).toBeNull();
  });

  it('defaults optional Pipedream settings when Cloud Run does not provide them', () => {
    const config = resolvePlatformIntegrationConfig({
      PIPEDREAM_CLIENT_ID: 'client-id',
      PIPEDREAM_CLIENT_SECRET: 'client-secret',
      PIPEDREAM_PROJECT_ID: 'project-id',
    }, 'postgres://db.example.com/matrixos_platform');

    expect(config).toMatchObject({
      pipedreamEnvironment: 'production',
      pipedreamWebhookSecret: '',
    });
  });
});

describe('GitHub integration config', () => {
  const valid = {
    GITHUB_INTEGRATION_OAUTH_ENABLED: 'true',
    GITHUB_OAUTH_CLIENT_ID: 'github-client-id',
    GITHUB_OAUTH_CLIENT_SECRET: 'github-client-secret',
    GITHUB_OAUTH_CALLBACK_URL: 'https://app.matrix-os.com/api/integrations/oauth/github/callback',
    GITHUB_OAUTH_WEB_COMPLETION_URL: 'https://app.matrix-os.com/integrations',
    GITHUB_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };

  it('is disabled by default and resolves every fixed OAuth endpoint when enabled', () => {
    expect(resolveGitHubIntegrationConfig({})).toBeNull();
    expect(resolveGitHubIntegrationConfig(valid)).toEqual({
      clientId: 'github-client-id',
      clientSecret: 'github-client-secret',
      callbackUrl: 'https://app.matrix-os.com/api/integrations/oauth/github/callback',
      webCompletionUrl: 'https://app.matrix-os.com/integrations',
      mobileCompletionUrl: 'matrixos://integrations',
      encryptionKey: valid.GITHUB_OAUTH_ENCRYPTION_KEY,
    });
  });

  it('fails closed when enabled config is incomplete or redirects are not fixed safe URLs', () => {
    expect(() => resolveGitHubIntegrationConfig({ ...valid, GITHUB_OAUTH_CLIENT_SECRET: '' }))
      .toThrow('GitHub OAuth configuration unavailable');
    expect(() => resolveGitHubIntegrationConfig({
      ...valid,
      GITHUB_OAUTH_CALLBACK_URL: 'http://app.matrix-os.com/api/integrations/oauth/github/callback',
    })).toThrow('GitHub OAuth callback URL is invalid');
    expect(() => resolveGitHubIntegrationConfig({
      ...valid,
      GITHUB_OAUTH_WEB_COMPLETION_URL: 'https://app.matrix-os.com/integrations?next=https://attacker.example',
    })).toThrow('GitHub OAuth completion URL is invalid');
  });

  it('rejects reuse of provider and platform secrets as the credential encryption key', () => {
    expect(() => resolveGitHubIntegrationConfig({
      ...valid,
      GITHUB_OAUTH_CLIENT_SECRET: valid.GITHUB_OAUTH_ENCRYPTION_KEY,
    })).toThrow('must not reuse another platform secret');
    expect(() => resolveGitHubIntegrationConfig({
      ...valid,
      PLATFORM_SECRET: valid.GITHUB_OAUTH_ENCRYPTION_KEY,
    })).toThrow('must not reuse another platform secret');
  });
});
