import { describe, expect, it } from 'vitest';
import { resolvePlatformIntegrationConfig } from '../../packages/platform/src/integration-config.js';

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
