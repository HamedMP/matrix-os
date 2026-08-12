import { randomUUID } from 'node:crypto';
import type { HetznerClient } from './customer-vps-hetzner.js';

const DEFAULT_CACHE_TTL_MS = 30_000;
const READ_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const CANARY_BODY = 'matrix-os-primary-storage-capability-check';

export interface R2CapabilityStorage {
  headObject(
    key: string,
    options?: { signal?: AbortSignal },
  ): Promise<{ exists: boolean; etag?: string }>;
  putObject(
    key: string,
    body: string | Uint8Array | ReadableStream<Uint8Array>,
    options?: { signal?: AbortSignal },
  ): Promise<{ etag?: string }>;
  deleteObject(key: string, options?: { signal?: AbortSignal }): Promise<void>;
}

export interface R2CapabilityGate {
  assertReady(options?: { force?: boolean }): Promise<void>;
}

export function createR2CapabilityGate(options: {
  storage: R2CapabilityStorage;
  cacheTtlMs?: number;
  now?: () => number;
  keyFactory?: () => string;
}): R2CapabilityGate {
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const keyFactory = options.keyFactory ?? (() => `_platform/canary/${randomUUID()}`);
  let lastSuccessAt: number | null = null;
  let inFlight: Promise<void> | null = null;

  async function probe(): Promise<void> {
    const key = keyFactory();
    let deleteError: unknown;
    let probeError: unknown;

    try {
      const initial = await options.storage.headObject(key, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (initial.exists) throw new Error('reserved canary key already exists');

      await options.storage.putObject(key, CANARY_BODY, {
        signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
      });
      const written = await options.storage.headObject(key, {
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
      });
      if (!written.exists) throw new Error('canary write was not visible');
    } catch (error: unknown) {
      probeError = error;
    } finally {
      try {
        await options.storage.deleteObject(key, {
          signal: AbortSignal.timeout(WRITE_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        deleteError = error;
      }

      try {
        const final = await options.storage.headObject(key, {
          signal: AbortSignal.timeout(READ_TIMEOUT_MS),
        });
        if (final.exists && deleteError === undefined) {
          deleteError = new Error('canary cleanup was not visible');
        }
      } catch (error: unknown) {
        if (deleteError === undefined) deleteError = error;
      }
    }

    if (probeError !== undefined || deleteError !== undefined) {
      throw new Error('Primary storage unavailable', {
        cause: probeError ?? deleteError,
      });
    }
  }

  return {
    async assertReady({ force = false } = {}): Promise<void> {
      if (!force && lastSuccessAt !== null && now() - lastSuccessAt <= cacheTtlMs) {
        return;
      }
      if (inFlight) return inFlight;

      inFlight = probe()
        .then(() => {
          lastSuccessAt = now();
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

export function createStorageGatedHetznerClient(
  base: HetznerClient,
  assertStorageReady: () => Promise<void>,
): HetznerClient {
  return {
    ...base,
    async createServer(input) {
      await assertStorageReady();
      return base.createServer(input);
    },
  };
}
