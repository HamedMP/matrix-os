import { describe, expect, it, vi } from 'vitest';
import type { CustomerVpsConfig } from '../../packages/platform/src/customer-vps-config.js';
import { createHetznerClient } from '../../packages/platform/src/customer-vps-hetzner.js';

const config = {
  hetznerApiToken: 'token',
  location: 'nbg1',
  serverType: 'cpx22',
  image: 'ubuntu-24.04',
} as CustomerVpsConfig;

describe('golden snapshot Hetzner provider contract', () => {
  it('creates a server from an exact image override and persists the Action id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      server: { id: 101, status: 'initializing', labels: { 'matrix.snapshot-id': 'snapshot-1' } },
      action: { id: 201, status: 'running', command: 'create_server' },
    }), { status: 201 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.createServer({
      name: 'matrix-snapshot-validator',
      userData: '#cloud-config\n',
      labels: { 'matrix.snapshot-id': 'snapshot-1' },
      image: 987,
      sshKeys: [],
    })).resolves.toMatchObject({ id: 101, createActionId: 201 });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toMatchObject({ image: 987, ssh_keys: [] });
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('creates a labelled snapshot and returns the asynchronous image and Action projections', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      image: {
        id: 301,
        status: 'creating',
        type: 'snapshot',
        architecture: 'x86',
        disk_size: 40,
        labels: { 'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001' },
        protection: { delete: false },
      },
      action: { id: 401, status: 'running', command: 'create_image' },
    }), { status: 201 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.createSnapshot(101, {
      description: 'Matrix OS golden snapshot',
      labels: { 'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001' },
    })).resolves.toMatchObject({
      image: { id: 301, status: 'creating', architecture: 'x86', diskGb: 40, deleteProtected: false },
      action: { id: 401, status: 'running', command: 'create_image' },
    });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      type: 'snapshot',
      description: 'Matrix OS golden snapshot',
      labels: { 'matrix.snapshot-id': '10000000-0000-4000-8000-000000000001' },
    });
  });

  it('reads image and Action readiness with strict bounded projections', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ image: {
        id: 301, status: 'available', type: 'snapshot', architecture: 'x86', disk_size: 40,
        labels: {}, protection: { delete: false },
      } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: {
        id: 401, status: 'success', command: 'create_image', error: null,
      } }), { status: 200 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.getImage(301)).resolves.toMatchObject({ id: 301, status: 'available' });
    await expect(client.getAction(401)).resolves.toEqual({ id: 401, status: 'success', command: 'create_image' });
  });

  it('reconciles images by exact label and treats exact-id 404 deletion as success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ images: [{
        id: 301, status: 'available', type: 'snapshot', architecture: 'x86', disk_size: 40,
        labels: { 'matrix.provenance': 'abc' }, protection: { delete: false },
      }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.listImagesByLabel('matrix.provenance=abc')).resolves.toHaveLength(1);
    await expect(client.deleteImage(301)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.hetzner.cloud/v1/images?type=snapshot&label_selector=matrix.provenance%3Dabc',
    );
  });

  it('rejects malformed provider image payloads instead of trusting unknown state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ image: {
      id: 301, status: 'mystery', type: 'snapshot', architecture: 'x86', disk_size: 40,
      labels: {}, protection: { delete: false },
    } }), { status: 200 }));
    const client = createHetznerClient(config, fetchImpl as unknown as typeof fetch);

    await expect(client.getImage(301)).rejects.toMatchObject({ code: 'provider_unavailable' });
  });
});
