import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { MATRIX_TELEMETRY_EVENTS } from '../../packages/observability/src/events.js';
import { CustomerVpsError } from '../../packages/platform/src/customer-vps-errors.js';
import {
  createCustomerVpsRoutes,
  type CustomerVpsRoutesDeps,
} from '../../packages/platform/src/customer-vps-routes.js';
import { vpsProvisionFailuresTotal } from '../../packages/platform/src/metrics.js';

const platformSecret = 'platform-secret';
const adminHeaders = {
  authorization: `Bearer ${platformSecret}`,
  'content-type': 'application/json',
};
const MACHINE_ID = '9f05824c-8d0a-4d83-9cb4-b312d43ff112';

type CaptureEvent = NonNullable<CustomerVpsRoutesDeps['captureEvent']>;

function buildApp(
  service: Partial<CustomerVpsRoutesDeps['service']>,
  captureEvent?: CaptureEvent,
): Hono {
  const app = new Hono();
  app.route('/vps', createCustomerVpsRoutes({
    service: service as CustomerVpsRoutesDeps['service'],
    platformSecret,
    captureEvent,
  }));
  return app;
}

function provisionRequest(app: Hono) {
  return app.request('/vps/provision', {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ clerkUserId: 'user_123', handle: 'alice' }),
  });
}

function registerRequest(app: Hono) {
  return app.request('/vps/register', {
    method: 'POST',
    headers: { authorization: 'Bearer registration-token', 'content-type': 'application/json' },
    body: JSON.stringify({
      machineId: MACHINE_ID,
      hetznerServerId: 123456,
      publicIPv4: '203.0.113.10',
      imageVersion: 'matrix-os-host-2026.06.11-1',
    }),
  });
}

describe('platform/customer-vps-routes telemetry', () => {
  beforeEach(() => {
    vpsProvisionFailuresTotal.reset();
  });

  it('captures matrix_vps_provision_requested with the clerk user as distinct id', async () => {
    const captureEvent = vi.fn();
    const service = {
      provision: vi.fn().mockResolvedValue({ machineId: MACHINE_ID, status: 'provisioning' }),
    };
    const app = buildApp(service, captureEvent);

    const res = await provisionRequest(app);

    expect(res.status).toBe(202);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_REQUESTED, {
      distinctId: 'user_123',
      properties: {
        handle: 'alice',
        runtime_slot: 'primary',
        requested_server_type: undefined,
        developer_tools_count: undefined,
      },
    });
  });

  it('captures matrix_vps_provision_failed with the CustomerVpsError failure code', async () => {
    const captureEvent = vi.fn();
    const service = {
      provision: vi.fn().mockRejectedValue(
        new CustomerVpsError(402, 'billing_required', 'Billing required'),
      ),
    };
    const app = buildApp(service, captureEvent);

    const res = await provisionRequest(app);

    expect(res.status).toBe(402);
    expect(await res.json()).toEqual({ error: 'Billing required' });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_FAILED, {
      distinctId: 'user_123',
      properties: { failure_code: 'billing_required', http_status: 402, handle: 'alice' },
    });
  });

  it('captures matrix_vps_provision_failed with failure_code unknown for non-CustomerVpsError failures', async () => {
    const captureEvent = vi.fn();
    const service = {
      provision: vi.fn().mockRejectedValue(new Error('hetzner exploded with secret details')),
    };
    const app = buildApp(service, captureEvent);

    const res = await provisionRequest(app);

    expect(res.status).toBe(500);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_FAILED, {
      distinctId: 'user_123',
      properties: { failure_code: 'unknown', http_status: 500, handle: 'alice' },
    });
    const failedCall = captureEvent.mock.calls.find(
      ([event]) => event === MATRIX_TELEMETRY_EVENTS.VPS_PROVISION_FAILED,
    );
    expect(JSON.stringify(failedCall)).not.toContain('hetzner');
  });

  it('increments matrix_vps_provision_failures_total with the failure_code label', async () => {
    const service = {
      provision: vi.fn().mockRejectedValue(
        new CustomerVpsError(429, 'quota_exceeded', 'Quota exceeded'),
      ),
    };
    const app = buildApp(service);

    const res = await provisionRequest(app);
    expect(res.status).toBe(429);

    const metric = await vpsProvisionFailuresTotal.get();
    expect(metric.values).toEqual([
      expect.objectContaining({ labels: { failure_code: 'quota_exceeded' }, value: 1 }),
    ]);
  });

  it('treats malformed provision bodies as request errors, not provision failures', async () => {
    const captureEvent = vi.fn();
    const service = { provision: vi.fn() };
    const app = buildApp(service, captureEvent);

    const malformed = await app.request('/vps/provision', {
      method: 'POST',
      headers: adminHeaders,
      body: '{not json',
    });
    const invalid = await app.request('/vps/provision', {
      method: 'POST',
      headers: adminHeaders,
      body: JSON.stringify({ unexpected: true }),
    });

    expect(malformed.status).toBe(400);
    expect(invalid.status).toBe(400);
    expect(service.provision).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
    const metric = await vpsProvisionFailuresTotal.get();
    expect(metric.values).toEqual([]);
  });

  it('treats malformed register bodies as request errors, not registration failures', async () => {
    const captureEvent = vi.fn();
    const service = { register: vi.fn() };
    const app = buildApp(service, captureEvent);

    const malformed = await app.request('/vps/register', {
      method: 'POST',
      headers: { authorization: 'Bearer registration-token', 'content-type': 'application/json' },
      body: '{not json',
    });

    expect(malformed.status).toBe(400);
    expect(service.register).not.toHaveBeenCalled();
    expect(captureEvent).not.toHaveBeenCalled();
  });

  it('never lets a throwing captureEvent affect the provision response', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const captureEvent = vi.fn(() => {
        throw new Error('posthog down');
      });
      const service = {
        provision: vi.fn().mockResolvedValue({ machineId: MACHINE_ID, status: 'provisioning' }),
      };
      const app = buildApp(service, captureEvent);

      const res = await provisionRequest(app);

      expect(res.status).toBe(202);
      expect(await res.json()).toEqual({ machineId: MACHINE_ID, status: 'provisioning' });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('still serves provision and register without a captureEvent dependency', async () => {
    const service = {
      provision: vi.fn().mockResolvedValue({ machineId: MACHINE_ID, status: 'provisioning' }),
      register: vi.fn().mockResolvedValue({ registered: true, status: 'running' }),
    };
    const app = buildApp(service);

    const provision = await provisionRequest(app);
    const register = await registerRequest(app);

    expect(provision.status).toBe(202);
    expect(register.status).toBe(200);
  });

  it('captures matrix_vps_registered on successful registration', async () => {
    const captureEvent = vi.fn();
    const service = {
      register: vi.fn().mockResolvedValue({ registered: true, status: 'running' }),
    };
    const app = buildApp(service, captureEvent);

    const res = await registerRequest(app);

    expect(res.status).toBe(200);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.VPS_REGISTERED, {
      properties: { machine_id: MACHINE_ID },
    });
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.RUNTIME_ACTIVATED, {
      properties: {
        machine_id: MACHINE_ID,
        image_version: 'matrix-os-host-2026.06.11-1',
      },
    });
  });

  it('captures matrix_vps_registration_failed with the failure code on rejection', async () => {
    const captureEvent = vi.fn();
    const service = {
      register: vi.fn().mockRejectedValue(
        new CustomerVpsError(401, 'registration_rejected', 'Registration rejected'),
      ),
    };
    const app = buildApp(service, captureEvent);

    const res = await registerRequest(app);

    expect(res.status).toBe(401);
    expect(captureEvent).toHaveBeenCalledTimes(1);
    expect(captureEvent).toHaveBeenCalledWith(MATRIX_TELEMETRY_EVENTS.VPS_REGISTRATION_FAILED, {
      properties: { failure_code: 'registration_rejected', http_status: 401, machine_id: MACHINE_ID },
    });
  });
});
