import { sign } from "node:crypto";
import { desktopPairingProofMessage } from "@matrix-os/contracts";
import type { BaseWindow } from "electron";
import { showMacActivityDialog } from "../mac-activity/dialog";
import { createMacActionPairing, type MacActionPairing } from "./action";
import { createPairingKeyStore, type KeyScope, type PairingSafeStorage } from "./key-store";
import { createPairingTransport, matchingPairingState, type PairingAuth, type PairingState } from "./transport";

interface DesktopPairingOptions {
  auth: PairingAuth;
  safeStorage: PairingSafeStorage;
  userData: string;
  window: () => BaseWindow | null;
  fetchFn?: typeof fetch;
}

export function createDesktopPairing(options: DesktopPairingOptions) {
  const keys = createPairingKeyStore(options.userData, options.safeStorage);
  const fetchFn = options.fetchFn ?? fetch;
  let pendingRevocation: KeyScope | undefined;
  let consentGeneration = 0;
  async function hasChatFullAccess(scope: KeyScope, state: PairingState) {
    if (pendingRevocation) return false;
    const generation = consentGeneration;
    try {
      return await keys.hasChatFullAccess(scope, state) && !pendingRevocation && generation === consentGeneration;
    } catch (error: unknown) {
      console.warn("[desktop-pairing] Chat Full Access consent unavailable", error instanceof Error ? error.name : "Error");
      return false;
    }
  }
  const actions = createMacActionPairing({ auth: options.auth, keys, fetchFn, hasChatFullAccess });
  let active: AbortController | undefined;
  let disconnecting = false;
  const acquireActionPairing: MacActionPairing = async (operation, signal) =>
    disconnecting ? null : actions.acquire(operation, signal);
  const acquireFullAccessPairing: MacActionPairing = async (operation, signal) =>
    disconnecting || pendingRevocation ? null : actions.acquireFullAccess(operation, signal);

  function show(message: string, signal: AbortSignal, detail?: string) {
    return showMacActivityDialog(options.window(), {
      title: "Matrix", type: "info", message, detail, buttons: ["OK"], signal,
    });
  }

  async function run(signal: AbortSignal) {
    const transport = createPairingTransport(options.auth, fetchFn, signal);
    if (!transport) {
      await show("Sign in to your primary Computer to manage Mac pairing.", signal);
      return;
    }
    const { origin, ownerId } = transport;
    const scope = { origin, ownerId };
    const state = await transport.read();
    const existing = await keys.load(scope);
    transport.assertCurrent();
    if (state.deviceId && state.deviceId !== existing?.deviceId) {
      await show("Another Mac is paired to this Computer.", signal);
      return;
    }

    const paired = state.deviceId !== null;
    const fullAccess = paired && await hasChatFullAccess(scope, state);
    transport.assertCurrent();
    const retryRevocation = pendingRevocation?.origin === origin && pendingRevocation.ownerId === ownerId;
    const fullAccessDetail = pendingRevocation
      ? "Chat Full Access is blocked on this Mac while a previous revocation needs attention."
      : "Chats set to Full Access can run Mac Verification on this Mac without asking each time. You can revoke this permission in Mac Pairing.";
    const buttons = paired ? ["Done", "Disconnect This Mac"] : ["Cancel", "Pair This Mac"];
    if (retryRevocation) buttons.push("Retry Chat Full Access Revocation");
    else if (!pendingRevocation) buttons.push(paired
      ? fullAccess ? "Revoke Chat Full Access" : "Allow Chat Full Access"
      : "Pair and Allow Chat Full Access");
    const { response } = await showMacActivityDialog(options.window(), {
      title: "Matrix",
      type: "question",
      message: paired ? "This Mac is paired." : "Pair this Mac?",
      detail: paired
        ? `Paired with ${origin}. ${fullAccess ? "Chat Full Access is allowed. " : ""}${fullAccessDetail}`
        : `Pair this Mac with ${origin}. ${fullAccessDetail}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      signal,
    });
    transport.assertCurrent();
    if ((response !== 1 && response !== 2) || !buttons[response]) return;
    if (response === 2 && (fullAccess || retryRevocation)) {
      pendingRevocation = scope;
      consentGeneration += 1;
      actions.revokeFullAccess();
      try {
        await keys.revokeChatFullAccess(scope);
      } catch (error: unknown) {
        console.warn("[desktop-pairing] could not revoke Chat Full Access", error instanceof Error ? error.name : "Error");
        await show("Chat Full Access could not be revoked.", signal, "Try again in Mac Pairing or disconnect this Mac.");
        return;
      }
      pendingRevocation = undefined;
      await show("Chat Full Access is revoked.", signal);
      return;
    }
    if (paired && response === 2) {
      if (!matchingPairingState(await transport.read(), state)) throw new Error("Pairing changed during approval");
      await keys.allowChatFullAccess(scope, state, signal, transport.assertCurrent);
      await show("Chat Full Access is allowed for Mac Verification.", signal);
      return;
    }

    const verifyMutation = async (mutate: () => Promise<PairingState>, deviceId: string | null) => {
      const expected = { ...state, deviceId, revision: state.revision + 1 };
      try {
        if (matchingPairingState(await mutate(), expected)) return expected;
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        transport.assertCurrent();
      }
      // Only a fresh read can reconcile a lost or malformed mutation reply.
      // Automatic resubmission is never safe after the request crossed the wire.
      if (!matchingPairingState(await transport.read(), expected)) throw new Error("Pairing outcome unconfirmed");
      return expected;
    };

    const deviceId = state.deviceId;
    if (deviceId !== null) {
      disconnecting = true;
      actions.revokeAll();
      try {
        if (!matchingPairingState(await transport.read(), state)) throw new Error("Pairing changed during approval");
        await verifyMutation(() => transport.revoke({ ...state, deviceId }), null);
        if (retryRevocation) pendingRevocation = undefined;
      } finally {
        disconnecting = false;
      }
      await show("This Mac is disconnected.", signal);
      return;
    }

    const key = existing ?? await keys.loadOrCreate(scope, signal);
    const challenge = await transport.challenge(key.deviceId, state.revision);
    if (challenge.machineId !== state.machineId || challenge.deviceId !== key.deviceId
        || challenge.revision !== state.revision || challenge.expiresAt <= Date.now()) {
      throw new Error("Pairing challenge changed");
    }
    const proof = desktopPairingProofMessage({ ownerId, machineId: state.machineId, deviceId: key.deviceId,
      revision: state.revision, nonce: challenge.nonce });
    const signature = sign(null, Buffer.from(proof), key.privateKey).toString("base64url");
    const enrolled = await verifyMutation(
      () => transport.pair({ nonce: challenge.nonce, publicKey: key.publicKey, signature }),
      key.deviceId,
    );
    if (response === 2) {
      try {
        await keys.allowChatFullAccess(scope, enrolled, signal, transport.assertCurrent);
      } catch (error: unknown) {
        if (signal.aborted) throw error;
        transport.assertCurrent();
        console.warn("[desktop-pairing] could not save Chat Full Access", error instanceof Error ? error.name : "Error");
        await show("This Mac is paired.", signal, "Chat Full Access could not be saved. Try again in Mac Pairing.");
        return;
      }
    }
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
    acquireActionPairing,
    acquireFullAccessPairing,
    cancel() {
      active?.abort();
      actions.revokeAll();
    },
  };
}
