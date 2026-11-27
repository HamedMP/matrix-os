import { sign } from "node:crypto";
import { desktopPairingActionProofMessage } from "@matrix-os/contracts";
import type { createPairingKeyStore } from "./key-store";
import { createPairingTransport, matchingPairingState, PairingBadGatewayError, type PairingAuth } from "./transport";

const CHECK_INTERVAL_MS = 3_000;
const MAX_TRACKED_ACTIONS = 4;

export interface MacActionPairingLease {
  check(signal?: AbortSignal, retryBadGateway?: () => boolean): Promise<boolean>;
  close(): void;
}

export type MacActionPairing = (
  operation: AbortController, admissionSignal?: AbortSignal,
) => Promise<MacActionPairingLease | null>;

function waitForRead(result: Promise<boolean>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return result;
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const onAbort = () => resolve(false);
    signal.addEventListener("abort", onAbort, { once: true });
    void result.then(current => {
      signal.removeEventListener("abort", onAbort);
      resolve(current && !signal.aborted);
    });
  });
}

export function createMacActionPairing(options: {
  auth: PairingAuth;
  keys: Pick<ReturnType<typeof createPairingKeyStore>, "load">;
  fetchFn: typeof fetch;
}) {
  const tracked = new Set<AbortController>();

  const acquire: MacActionPairing = async (operation, admissionSignal) => {
    if (operation.signal.aborted || admissionSignal?.aborted
      || tracked.has(operation) || tracked.size >= MAX_TRACKED_ACTIONS) return null;
    const worker = new AbortController();
    const transport = createPairingTransport(options.auth, options.fetchFn, worker.signal);
    if (!transport || operation.signal.aborted) return null;
    tracked.add(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    operation.signal.addEventListener("abort", close, { once: true });

    function close() {
      if (worker.signal.aborted) return;
      clearTimeout(timer);
      tracked.delete(operation);
      operation.signal.removeEventListener("abort", close);
      worker.abort();
    }

    function revoke(error?: unknown) {
      if (!worker.signal.aborted) {
        if (error !== undefined) {
          console.warn("[desktop-pairing] action verification failed", error instanceof Error ? error.name : "Error");
        }
        operation.abort("revoked");
      }
      return false;
    }

    let granted = false;
    try {
      const state = await transport.read(admissionSignal);
      if (!state.deviceId) return null;
      const { origin, ownerId } = transport;
      const key = await options.keys.load({ origin, ownerId });
      if (!key || key.deviceId !== state.deviceId) return null;
      const challenge = await transport.actionChallenge(key.deviceId, state.revision, admissionSignal);
      if (!matchingPairingState(state, challenge) || challenge.expiresAt <= Date.now()) return null;
      const proof = desktopPairingActionProofMessage({ ownerId, machineId: state.machineId,
        deviceId: key.deviceId, revision: state.revision, nonce: challenge.nonce });
      const signature = sign(null, Buffer.from(proof), key.privateKey).toString("base64url");
      if (!matchingPairingState(state, await transport.verifyAction({ nonce: challenge.nonce, signature }, admissionSignal))) {
        revoke();
        return null;
      }
      if (admissionSignal?.aborted || worker.signal.aborted) return null;

      const authority = transport;
      let pending: Promise<boolean> | undefined;
      async function readCurrent(signal?: AbortSignal, retryBadGateway?: () => boolean): Promise<boolean> {
        try {
          const current = await authority.read().catch((error: unknown) => {
            if (!(error instanceof PairingBadGatewayError) || worker.signal.aborted || signal?.aborted
              || !retryBadGateway?.()) throw error;
            return authority.read();
          });
          return matchingPairingState(state, current) || revoke();
        } catch (error: unknown) {
          return revoke(error);
        }
      }

      function getPendingRead(signal?: AbortSignal, retryBadGateway?: () => boolean) {
        return pending ??= readCurrent(signal, retryBadGateway).finally(() => { pending = undefined; });
      }

      async function check(signal?: AbortSignal, retryBadGateway?: () => boolean): Promise<boolean> {
        if (worker.signal.aborted || signal?.aborted) return false;
        // A poll already in flight may have read the row before this action boundary.
        // Wait for it to settle, then use a read initiated after entering the boundary.
        if (pending && !await waitForRead(pending, signal)) return false;
        if (worker.signal.aborted || signal?.aborted) return false;
        if (!await waitForRead(getPendingRead(signal, retryBadGateway), signal) || worker.signal.aborted) return false;
        try {
          authority.assertCurrent();
          return true;
        } catch (error: unknown) {
          return revoke(error);
        }
      }

      function schedule() {
        timer = setTimeout(() => {
          void getPendingRead().then(current => {
            if (current && !worker.signal.aborted) schedule();
          });
        }, CHECK_INTERVAL_MS);
        timer.unref();
      }

      schedule();
      granted = true;
      return { check, close };
    } catch (error: unknown) {
      if (!admissionSignal?.aborted) revoke(error);
      return null;
    } finally {
      if (!granted) close();
    }
  };

  return {
    acquire,
    revokeAll() {
      for (const operation of [...tracked]) operation.abort("revoked");
    },
  };
}
