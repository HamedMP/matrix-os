import { sign } from "node:crypto";
import { desktopPairingProofMessage, type DesktopPairingStateSchema } from "@matrix-os/contracts";
import type { BaseWindow } from "electron";
import type { z } from "zod/v4";
import { showMacActivityDialog } from "../mac-activity/dialog";
import { createPairingKeyStore, type PairingSafeStorage } from "./key-store";
import { createPairingTransport, type PairingAuth } from "./transport";

type PairingState = z.infer<typeof DesktopPairingStateSchema>;

interface DesktopPairingOptions {
  auth: PairingAuth;
  safeStorage: PairingSafeStorage;
  userData: string;
  window: () => BaseWindow | null;
  fetchFn?: typeof fetch;
}

function matchingState(a: PairingState, b: PairingState) {
  return a.machineId === b.machineId && a.deviceId === b.deviceId && a.revision === b.revision;
}

export function createDesktopPairing(options: DesktopPairingOptions) {
  const keys = createPairingKeyStore(options.userData, options.safeStorage);
  let active: AbortController | undefined;

  function show(message: string, signal: AbortSignal, detail?: string) {
    return showMacActivityDialog(options.window(), {
      title: "Matrix", type: "info", message, detail, buttons: ["OK"], signal,
    });
  }

  async function run(signal: AbortSignal) {
    const transport = createPairingTransport(options.auth, options.fetchFn ?? fetch, signal);
    if (!transport) {
      await show("Sign in to your primary Computer to manage Mac pairing.", signal);
      return;
    }
    const { origin, ownerId } = transport;
    const state = await transport.read();
    const existing = await keys.load({ origin, ownerId });
    transport.assertCurrent();
    if (state.deviceId && state.deviceId !== existing?.deviceId) {
      await show("Another Mac is paired to this Computer.", signal);
      return;
    }

    const disconnect = state.deviceId !== null;
    const { response } = await showMacActivityDialog(options.window(), {
      title: "Matrix",
      type: "question",
      message: disconnect ? "Disconnect this Mac?" : "Pair this Mac?",
      detail: disconnect
        ? `Remove this Mac’s pairing with ${origin}. You can pair it again later.`
        : `Pair this Mac with ${origin}. Chat actions still require their own approval.`,
      buttons: ["Cancel", disconnect ? "Disconnect This Mac" : "Pair This Mac"],
      defaultId: 0,
      cancelId: 0,
      signal,
    });
    transport.assertCurrent();
    if (response !== 1) return;

    const verifyMutation = async (mutate: () => Promise<PairingState>, deviceId: string | null) => {
      const expected = { ...state, deviceId, revision: state.revision + 1 };
      try {
        if (matchingState(await mutate(), expected)) return;
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        transport.assertCurrent();
      }
      // Only a fresh read can reconcile a lost or malformed mutation reply.
      // Automatic resubmission is never safe after the request crossed the wire.
      if (!matchingState(await transport.read(), expected)) throw new Error("Pairing outcome unconfirmed");
    };

    const deviceId = state.deviceId;
    if (deviceId !== null) {
      if (!matchingState(await transport.read(), state)) throw new Error("Pairing changed during approval");
      await verifyMutation(() => transport.revoke({ ...state, deviceId }), null);
      await show("This Mac is disconnected.", signal);
      return;
    }

    const key = existing ?? await keys.loadOrCreate({ origin, ownerId }, signal);
    const challenge = await transport.challenge(key.deviceId, state.revision);
    if (challenge.machineId !== state.machineId || challenge.deviceId !== key.deviceId
        || challenge.revision !== state.revision || challenge.expiresAt <= Date.now()) {
      throw new Error("Pairing challenge changed");
    }
    const proof = desktopPairingProofMessage({ ownerId, machineId: state.machineId, deviceId: key.deviceId,
      revision: state.revision, nonce: challenge.nonce });
    const signature = sign(null, Buffer.from(proof), key.privateKey).toString("base64url");
    await verifyMutation(() => transport.pair({ nonce: challenge.nonce, publicKey: key.publicKey, signature }), key.deviceId);
    await show("This Mac is paired.", signal);
  }

  return {
    async open() {
      if (active) return;
      const operation = new AbortController();
      active = operation;
      try {
        await run(operation.signal);
      } catch (error: unknown) {
        if (operation.signal.aborted) return;
        console.warn("[desktop-pairing] request failed", error instanceof Error ? error.name : "Error");
        try {
          await show("Mac pairing could not be confirmed.", operation.signal, "Open Mac Pairing again to check the current state.");
        } catch (dialogError: unknown) {
          if (!operation.signal.aborted) {
            console.warn("[desktop-pairing] could not open dialog", dialogError instanceof Error ? dialogError.name : "Error");
          }
        }
      } finally {
        active = undefined;
      }
    },
    cancel() { active?.abort(); },
  };
}
