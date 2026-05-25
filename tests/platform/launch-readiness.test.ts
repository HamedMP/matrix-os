import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Orchestrator } from '../../packages/platform/src/orchestrator.js';
import { createApp } from '../../packages/platform/src/main.js';
import {
  createLaunchReadinessService,
  createPlatformLaunchEvidenceLoader,
  type LaunchReadinessGate,
} from '../../packages/platform/src/launch-readiness.js';
import {
  insertUserMachine,
  promoteHostBundleChannel,
  upsertHostBundleRelease,
} from '../../packages/platform/src/db.js';
import { createLaunchReadinessRoutes } from '../../packages/platform/src/launch-readiness-routes.js';
import { createTestPlatformDb, destroyTestPlatformDb } from './platform-db-test-helper.js';

const nowIso = '2026-05-23T12:00:00.000Z';

function passingGate(id: string): LaunchReadinessGate {
  return {
    id,
    category: 'ux',
    criticality: 'release_critical',
    status: 'pass',
    owner: 'matrix',
    message: `${id} passed`,
    remediation: null,
    lastCheckedAt: nowIso,
  };
}

describe('platform/launch-readiness', () => {
  function stubOrchestrator(): Orchestrator {
    return {
      provision: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      destroy: vi.fn(),
      upgrade: vi.fn(),
      rollingRestart: vi.fn(),
      getInfo: vi.fn(),
      getImage: vi.fn(),
      listAll: vi.fn().mockReturnValue([]),
      syncStates: vi.fn(),
    } as unknown as Orchestrator;
  }

  it('marks paid beta unsafe when a release-critical gate fails', async () => {
    const service = createLaunchReadinessService({
      now: () => new Date(nowIso),
      loadEvidence: async () => ({
        promotedRelease: true,
        freshWorkspace: true,
        existingWorkspace: true,
        shellRouting: true,
        onboardingEducation: true,
        visualQa: false,
        integrations: true,
        hermesContinuity: true,
        agentExecution: true,
        codingHandoff: true,
        companyBrain: true,
        supportGrowth: true,
        adminControlSurface: true,
        entitlementGate: true,
      }),
    });

    const report = await service.getReport();

    expect(report.launchReady).toBe(false);
    expect(report.overallStatus).toBe('blocked');
    expect(report.gates.find((gate) => gate.id === 'onboarding.visual_qa')).toMatchObject({
      status: 'fail',
      owner: 'matrix',
      remediation: 'Run desktop, mobile, reduced-motion, and missing-media onboarding visual QA.',
    });
  });

  it('requires both fresh and existing workspace rehearsals before launch-ready', async () => {
    const service = createLaunchReadinessService({
      now: () => new Date(nowIso),
      loadEvidence: async () => ({
        promotedRelease: true,
        freshWorkspace: true,
        existingWorkspace: false,
        shellRouting: true,
        onboardingEducation: true,
        visualQa: true,
        integrations: true,
        hermesContinuity: true,
        agentExecution: true,
        codingHandoff: true,
        companyBrain: true,
        supportGrowth: true,
        adminControlSurface: true,
        entitlementGate: true,
      }),
    });

    const report = await service.getReport();

    expect(report.launchReady).toBe(false);
    expect(report.gates.find((gate) => gate.id === 'workspace.existing_rehearsal')).toMatchObject({
      status: 'fail',
      owner: 'operator',
      message: 'Existing workspace rehearsal has not passed.',
    });
  });

  it('returns launch-ready only when every release-critical gate passes', async () => {
    const service = createLaunchReadinessService({
      now: () => new Date(nowIso),
      loadEvidence: async () => ({
        promotedRelease: true,
        freshWorkspace: true,
        existingWorkspace: true,
        shellRouting: true,
        onboardingEducation: true,
        visualQa: true,
        integrations: true,
        hermesContinuity: true,
        agentExecution: true,
        codingHandoff: true,
        companyBrain: true,
        supportGrowth: true,
        adminControlSurface: true,
        entitlementGate: true,
      }),
    });

    await expect(service.getReport()).resolves.toMatchObject({
      launchReady: true,
      overallStatus: 'ready',
    });
  });

  it('keeps operator-owned rehearsal gates fail-closed without explicit evidence flags', async () => {
    const { db } = await createTestPlatformDb();
    try {
      await upsertHostBundleRelease(db, {
        version: 'v2026.05.23-test',
        gitCommit: 'abcdef123456',
        gitRef: 'main',
        buildTime: nowIso,
        bundleKey: 'system-bundles/v2026.05.23-test/matrix-host-bundle.tar.gz',
        checksumKey: 'system-bundles/v2026.05.23-test/matrix-host-bundle.tar.gz.sha256',
        sha256: 'a'.repeat(64),
        size: 123,
      });
      await promoteHostBundleChannel(db, 'beta', 'v2026.05.23-test', nowIso);
      await insertUserMachine(db, {
        machineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff112',
        clerkUserId: 'user_123',
        handle: 'alice',
        status: 'running',
        publicIPv4: '192.0.2.1',
        provisionedAt: nowIso,
        lastSeenAt: nowIso,
      });
      await insertUserMachine(db, {
        machineId: '721c3ef8-23f6-47e4-a890-6f6dc14759d1',
        clerkUserId: 'user_456',
        handle: 'bob',
        status: 'running',
        publicIPv4: '192.0.2.2',
        provisionedAt: nowIso,
        lastSeenAt: nowIso,
      });

      const loadEvidence = createPlatformLaunchEvidenceLoader({ db, env: {} });

      await expect(loadEvidence()).resolves.toMatchObject({
        promotedRelease: true,
        freshWorkspace: false,
        existingWorkspace: false,
        shellRouting: false,
      });
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it('matches the proxy default when entitlement evidence omits enforcement status', async () => {
    const { db } = await createTestPlatformDb();
    try {
      const loadWithoutEnforcement = createPlatformLaunchEvidenceLoader({
        db,
        env: { MATRIX_LAUNCH_ENTITLEMENT_GATE: 'true' } as NodeJS.ProcessEnv,
      });
      await expect(loadWithoutEnforcement()).resolves.toMatchObject({
        entitlementGate: true,
      });

      const loadWithEnforcement = createPlatformLaunchEvidenceLoader({
        db,
        env: {
          MATRIX_LAUNCH_ENTITLEMENT_GATE: 'true',
          MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'active',
        } as NodeJS.ProcessEnv,
      });
      await expect(loadWithEnforcement()).resolves.toMatchObject({
        entitlementGate: true,
      });
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it('does not pass entitlement evidence for unrecognized enforcement statuses', async () => {
    const { db } = await createTestPlatformDb();
    try {
      const loadEvidence = createPlatformLaunchEvidenceLoader({
        db,
        env: {
          MATRIX_LAUNCH_ENTITLEMENT_GATE: 'true',
          MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'not-real',
        } as NodeJS.ProcessEnv,
      });

      await expect(loadEvidence()).resolves.toMatchObject({
        entitlementGate: false,
      });
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it('does not pass entitlement evidence for blocking enforcement statuses', async () => {
    const { db } = await createTestPlatformDb();
    try {
      const loadEvidence = createPlatformLaunchEvidenceLoader({
        db,
        env: {
          MATRIX_LAUNCH_ENTITLEMENT_GATE: 'true',
          MATRIX_PAID_BETA_ENTITLEMENT_STATUS: 'expired',
        } as NodeJS.ProcessEnv,
      });

      await expect(loadEvidence()).resolves.toMatchObject({
        entitlementGate: false,
      });
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it('protects the operator readiness route with the platform bearer token', async () => {
    const app = new Hono();
    const service = {
      getReport: vi.fn().mockResolvedValue({
        generatedAt: nowIso,
        launchReady: true,
        overallStatus: 'ready',
        gates: [passingGate('onboarding.visual_qa')],
      }),
    };
    app.route('/api/operator', createLaunchReadinessRoutes({
      service,
      platformSecret: 'platform-secret',
    }));

    const unauthorized = await app.request('/api/operator/launch-readiness');
    expect(unauthorized.status).toBe(401);

    const authorized = await app.request('/api/operator/launch-readiness', {
      headers: { authorization: 'Bearer platform-secret' },
    });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toMatchObject({ launchReady: true });
  });

  it('mounts the operator readiness route on the platform app', async () => {
    const { db } = await createTestPlatformDb();
    try {
      const app = createApp({
        db,
        orchestrator: stubOrchestrator(),
        platformSecret: 'platform-secret',
      });

      const res = await app.request('/api/operator/launch-readiness', {
        headers: { authorization: 'Bearer platform-secret' },
      });

      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        launchReady: false,
        overallStatus: 'blocked',
      });
    } finally {
      await destroyTestPlatformDb(db);
    }
  });

  it('returns generic route errors when readiness aggregation fails', async () => {
    const app = new Hono();
    app.route('/api/operator', createLaunchReadinessRoutes({
      service: {
        getReport: vi.fn().mockRejectedValue(new Error('database password leaked')),
      },
      platformSecret: 'platform-secret',
    }));

    const res = await app.request('/api/operator/launch-readiness', {
      headers: { authorization: 'Bearer platform-secret' },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'Launch readiness unavailable' });
  });
});
