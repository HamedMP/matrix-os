import { describe, expect, it, vi } from 'vitest';
import {
  activateSpeechFleet,
  selectTargetMachine,
} from '../../scripts/ci/targeted-fleet-maintenance.mjs';

function fleetMachine(overrides: Record<string, unknown> = {}) {
  return {
    handle: 'customer-one',
    runtimeSlot: 'primary',
    provisioningClass: 'customer',
    activationState: 'authorized',
    status: 'running',
    healthy: false,
    deletedAt: null,
    publicIPv4: '203.0.113.10',
    ...overrides,
  };
}

describe('targeted fleet maintenance', () => {
  it('selects exactly one complete, authorized customer fixture', () => {
    expect(selectTargetMachine({
      truncated: false,
      machines: [
        fleetMachine(),
        fleetMachine({ handle: 'healthy', healthy: true }),
        fleetMachine({ handle: 'preview', provisioningClass: 'preview' }),
        fleetMachine({ handle: 'prebilling', activationState: 'awaiting_billing' }),
      ],
    })).toEqual({ handle: 'customer-one' });
  });

  it.each([
    ['a truncated fleet', { truncated: true, machines: [fleetMachine()] }],
    ['no eligible machine', { truncated: false, machines: [fleetMachine({ healthy: true })] }],
    ['multiple eligible machines', {
      truncated: false,
      machines: [fleetMachine(), fleetMachine({ handle: 'customer-two' })],
    }],
  ])('fails closed for %s', (_label, fixture) => {
    expect(() => selectTargetMachine(fixture)).toThrow();
  });

  it('retries a transient speech HTTP failure and verifies the page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
      .mockResolvedValueOnce(Response.json({
        activated: 2,
        failed: 0,
        complete: true,
        nextCursor: null,
      }));
    const sleep = vi.fn(async () => undefined);

    await expect(activateSpeechFleet({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'secret',
      fetchImpl,
      sleep,
    })).resolves.toEqual({ activated: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('continues from a verified page cursor without replaying the page', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({
        activated: 16,
        failed: 0,
        complete: false,
        nextCursor: '9f05824c-8d0a-4d83-9cb4-b312d43ff200',
      }))
      .mockResolvedValueOnce(Response.json({
        activated: 1,
        failed: 0,
        complete: true,
        nextCursor: null,
      }));

    await expect(activateSpeechFleet({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'secret',
      fetchImpl,
      sleep: async () => undefined,
    })).resolves.toEqual({ activated: 17 });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({});
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      afterMachineId: '9f05824c-8d0a-4d83-9cb4-b312d43ff200',
    });
  });

  it('fails before making another request after its elapsed-time budget', async () => {
    const fetchImpl = vi.fn();

    await expect(activateSpeechFleet({
      platformUrl: 'https://app.matrix-os.com',
      platformSecret: 'secret',
      fetchImpl,
      sleep: async () => undefined,
      budgetMs: 0,
    })).rejects.toThrow('elapsed-time budget');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
