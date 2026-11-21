import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { getUserMachine, insertUserMachine, type NewUserMachine, type PlatformDB } from '../../packages/platform/src/db.js';
import { createMetalHostsRepository } from '../../packages/platform/src/substrates/metal-hosts-repository.js';
import { createMetalHostDirectory, createMetalSubstrate } from '../../packages/platform/src/substrates/metal-substrate.js';
import { createSubstrateRegistry, type SubstrateRegistry } from '../../packages/platform/src/substrates/registry.js';
import { createVpsSubstrate } from '../../packages/platform/src/substrates/vps-substrate.js';
import { generateSelfSignedCert, json, startFakeHostd, type FakeHostd, type FakeHostdRequest } from './fake-hostd-server.js';
import { startFakeMetalIngress, type FakeMetalIngress } from './fake-metal-ingress.js';

/**
 * A metal runtime wired end to end for routing tests (ENG-520): a real metal
 * substrate talking to a fake hostd, a fake ingress, both over verified TLS
 * with a staging CA, and a platform record in the test database.
 */

export const OWNER = 'user_alice';
export const HANDLE = 'alice';
export const API_TOKEN = 'api-token-'.padEnd(40, 'x');
export const INGRESS_TOKEN = 'ingress-token-'.padEnd(40, 'y');
export const VM_ID = 'vm_0123456789abcdef01234567';
export const GENERATION = 3;

export type ResumeBehaviour =
  | { kind: 'state'; state: 'running' | 'starting'; delayMs?: number }
  | { kind: 'error'; status: number; error: string };

export interface MetalWakeRig {
  machineId: string;
  hostd: FakeHostd;
  ingress: FakeMetalIngress;
  substrates: SubstrateRegistry;
  resume: ResumeBehaviour;
  /** When true, hostd accepts connections but never answers. */
  hostdHangs: boolean;
  resumeCalls(): FakeHostdRequest[];
  machine(): ReturnType<typeof getUserMachine>;
  close(): Promise<void>;
}

export async function createMetalWakeRig(
  db: PlatformDB,
  overrides: Partial<NewUserMachine> = {},
  options: { requestWaitMs?: number; hostdTimeoutMs?: number } = {},
): Promise<MetalWakeRig> {
  const cert = generateSelfSignedCert();
  const hostd = await startFakeHostd(cert);
  const ingress = await startFakeMetalIngress(cert);
  // Unique per rig: the owner-activity throttle is process-wide.
  const machineId = `metal-${randomUUID()}`;
  const rig = { resume: { kind: 'state', state: 'running' } as ResumeBehaviour, hostdHangs: false };

  hostd.handle((req, res: ServerResponse) => {
    if (rig.hostdHangs) return;
    if (req.method === 'GET' && req.path === `/v1/vms/${VM_ID}`) {
      json(res, 200, {
        id: VM_ID, machineId, generation: GENERATION, handle: HANDLE, tier: 'free', state: 'suspended',
        privateIPv4: '10.77.0.5', bootMiB: 2048, maxMiB: 8192, diskGiB: 20, chVersion: 'v48.0', snapshot: null,
        updatedAt: '2026-11-21T10:00:00.000Z',
      });
      return;
    }
    if (req.method === 'POST' && req.path === `/v1/vms/${VM_ID}/resume`) {
      const behaviour = rig.resume;
      if (behaviour.kind === 'error') {
        json(res, behaviour.status, { error: behaviour.error });
        return;
      }
      setTimeout(() => json(res, 200, { state: behaviour.state }), behaviour.delayMs ?? 0);
      return;
    }
    json(res, 404, { error: 'not_found' });
  });

  const repo = createMetalHostsRepository(db.kysely);
  await repo.upsert({
    id: 'metal-1', name: 'metal-1', apiUrl: hostd.origin, ingressHost: ingress.ingressHost, status: 'active',
    memoryCapacityMib: 131072, admissionCeilingMib: 114688,
  });
  await insertUserMachine(db, {
    machineId, clerkUserId: OWNER, handle: HANDLE, status: 'suspended', imageVersion: 'matrix-os-host-dev',
    provisionedAt: '2026-11-01T00:00:00.000Z', substrate: 'metal', generation: GENERATION,
    metalHostId: 'metal-1', metalVmId: VM_ID, hetznerServerId: null, publicIPv4: null,
    ...overrides,
  });

  const loadMachine = (id: string) => getUserMachine(db, id);
  const hosts = createMetalHostDirectory(repo);
  await hosts.prime();
  const substrates = createSubstrateRegistry([
    createVpsSubstrate({ loadMachine }),
    createMetalSubstrate({
      loadMachine, hosts, apiToken: API_TOKEN, ingressToken: INGRESS_TOKEN, caPem: cert.cert,
      ...(options.requestWaitMs === undefined ? {} : { requestWaitMs: options.requestWaitMs }),
      ...(options.hostdTimeoutMs === undefined ? {} : { clientOptions: { timeoutMs: options.hostdTimeoutMs } }),
    }),
  ]);

  return {
    machineId,
    hostd,
    ingress,
    substrates,
    get resume() { return rig.resume; },
    set resume(value: ResumeBehaviour) { rig.resume = value; },
    get hostdHangs() { return rig.hostdHangs; },
    set hostdHangs(value: boolean) { rig.hostdHangs = value; },
    resumeCalls: () => hostd.requests.filter((req) => req.path.endsWith('/resume')),
    machine: () => getUserMachine(db, machineId),
    async close() {
      await Promise.all([hostd.close(), ingress.close()]);
    },
  };
}
