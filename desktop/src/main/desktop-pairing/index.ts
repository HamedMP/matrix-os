import { sign, type KeyObject } from "node:crypto";
import { desktopPairingProofMessage } from "@matrix-os/contracts";
import type { BaseWindow } from "electron";
import { showDesktopLinkDialog } from "./dialog";
import { createPairingKeyStore, type KeyScope, type PairingSafeStorage } from "./key-store";
import { createPairingTransport, matchingPairingState, type PairingAuth, type PairingState } from "./transport";

interface DesktopPairingOptions {
  auth: PairingAuth;
  safeStorage: PairingSafeStorage;
  userData: string;
  window: () => BaseWindow | null;
  fetchFn?: typeof fetch;
  platform?: NodeJS.Platform;
  /** The local Desktop Link consumer is installed and can act on this grant. */
  desktopLinkAvailable?: boolean;
  /** After a pairing commits: the desktop link (spec 2716) connects. */
  onPaired?(): void;
  /** As the owner confirms Disconnect, before the request: the desktop link closes first. */
  onDisconnecting?(): void;
}

/** The paired device's identity for the desktop link (spec 2716). */
export interface PairedLinkIdentity {
  origin: string;
  ownerId: string;
  machineId: string;
  deviceId: string;
  revision: number;
  privateKey: KeyObject;
}

/** What the dialogs call this device. */
export function pairingDeviceNoun(platform: NodeJS.Platform): string {
  return platform === "darwin" ? "Mac" : platform === "win32" ? "PC" : "desktop";
}

const ALLOW_LINK_FULL_ACCESS = "Allow Desktop Link Full Access";
const REVOKE_LINK_FULL_ACCESS = "Revoke Desktop Link Full Access";

export function createDesktopPairing(options: DesktopPairingOptions) {
  const keys = createPairingKeyStore(options.userData, options.safeStorage);
  const noun = pairingDeviceNoun(options.platform ?? process.platform);
  const fetchFn = options.fetchFn ?? fetch;
  let active: AbortController | undefined;
  let disconnecting = false;

  function show(message: string, signal: AbortSignal, detail?: string) {
    return showDesktopLinkDialog(options.window(), {
      title: "Matrix", type: "info", message, detail, buttons: ["OK"], signal,
    });
  }

  async function run(signal: AbortSignal) {
    const transport = createPairingTransport(options.auth, fetchFn, signal);
    if (!transport) {
      await show(`Sign in to your primary Computer to manage ${noun} pairing.`, signal);
      return;
    }
    const { origin, ownerId } = transport;
    const scope = { origin, ownerId };
    const state = await transport.read();
    const existing = await keys.load(scope);
    transport.assertCurrent();
    if (state.deviceId && state.deviceId !== existing?.deviceId) {
      await show(`Another ${noun} is paired to this Computer.`, signal);
      return;
    }

    const paired = state.deviceId !== null;
    const inventoryDetail = " While Desktop Link is on, your private Chat can list computer names and connection states from this desktop.";
    const buttons = paired ? ["Done", `Disconnect This ${noun}`] : ["Cancel", `Pair This ${noun}`];
    const linkAvailable = options.desktopLinkAvailable === true;
    const linkFullAccess = paired && linkAvailable && await hasLinkFullAccess(scope, state);
    transport.assertCurrent();
    if (paired && linkAvailable) buttons.push(linkFullAccess ? REVOKE_LINK_FULL_ACCESS : ALLOW_LINK_FULL_ACCESS);
    const linkDetail = linkFullAccess
      ? " Desktop Link Full Access lets your computer start terminals, open your other terminals and take screenshots here without asking."
      : " Your computer asks here before it starts a terminal, opens one you started, or takes a screenshot."
        + " Full Access would let anything running on your computer, its agents included, do that without asking.";
    const { response } = await showDesktopLinkDialog(options.window(), {
      title: "Matrix",
      type: "question",
      message: paired ? `This ${noun} is paired.` : `Pair this ${noun}?`,
      detail: !linkAvailable
        ? `Pairing identifies this ${noun} to ${origin}. You can disconnect at any time.`
        : paired
        ? `Paired with ${origin}. You can disconnect at any time.${linkDetail}${inventoryDetail}`
        : `Pair this ${noun} with ${origin}. Your Matrix computer can then reach this ${noun} over its desktop link.${inventoryDetail}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      signal,
    });
    transport.assertCurrent();
    if (buttons[response] === ALLOW_LINK_FULL_ACCESS) {
      if (!matchingPairingState(await transport.read(), state)) throw new Error("Pairing changed during approval");
      await keys.allowLinkFullAccess(scope, state, signal, transport.assertCurrent);
      await show("Desktop Link Full Access is allowed.", signal);
      return;
    }
    if (buttons[response] === REVOKE_LINK_FULL_ACCESS) {
      await keys.revokeLinkFullAccess(scope);
      await show("Desktop Link Full Access is revoked.", signal, "Your computer asks here again before each start or screenshot.");
      return;
    }
    if (response !== 1) return;

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
      notify(options.onDisconnecting);
      try {
        if (!matchingPairingState(await transport.read(), state)) throw new Error("Pairing changed during approval");
        await verifyMutation(() => transport.revoke({ ...state, deviceId }), null);
      } finally {
        disconnecting = false;
      }
      await show(`This ${noun} is disconnected.`, signal);
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
    await verifyMutation(
      () => transport.pair({ nonce: challenge.nonce, publicKey: key.publicKey, signature }),
      key.deviceId,
    );
    notify(options.onPaired);
    await show(`This ${noun} is paired.`, signal);
  }

  /** Desktop link Full Access for exactly this pairing; an unreadable record is no consent. */
  async function hasLinkFullAccess(scope: KeyScope, state: PairingState): Promise<boolean> {
    try {
      return await keys.hasLinkFullAccess(scope, state);
    } catch (error: unknown) {
      console.warn("[desktop-pairing] desktop link Full Access unavailable", error instanceof Error ? error.name : "Error");
      return false;
    }
  }

  function notify(hook: (() => void) | undefined) {
    try {
      hook?.();
    } catch (error: unknown) {
      console.warn("[desktop-pairing] desktop link notice failed", error instanceof Error ? error.name : "Error");
    }
  }

  /**
   * This device's pairing key, when the primary computer has it paired at the
   * current revision (spec 2716): what the desktop link signs its admission with.
   * Null when signed out, unpaired, paired to another device, or disconnecting.
   */
  async function linkIdentity(signal: AbortSignal): Promise<PairedLinkIdentity | null> {
    if (disconnecting) return null;
    const transport = createPairingTransport(options.auth, fetchFn, signal);
    if (!transport) return null;
    const state = await transport.read(signal);
    if (!state.deviceId) return null;
    const key = await keys.load({ origin: transport.origin, ownerId: transport.ownerId });
    transport.assertCurrent();
    if (!key || key.deviceId !== state.deviceId || disconnecting) return null;
    return {
      origin: transport.origin, ownerId: transport.ownerId, machineId: state.machineId,
      deviceId: key.deviceId, revision: state.revision, privateKey: key.privateKey,
    };
  }

  function cancel() {
    active?.abort();
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
          await show(`${noun[0]!.toUpperCase()}${noun.slice(1)} pairing could not be confirmed.`, operation.signal,
            "Open device pairing again to check the current state.");
        } catch (dialogError: unknown) {
          if (!operation.signal.aborted) {
            console.warn("[desktop-pairing] could not open dialog", dialogError instanceof Error ? dialogError.name : "Error");
          }
        }
      } finally {
        active = undefined;
      }
    },
    linkIdentity,
    /** Whether the owner allowed desktop link Full Access at the pairing the link proves. */
    linkFullAccess: (identity: PairedLinkIdentity) => hasLinkFullAccess(
      { origin: identity.origin, ownerId: identity.ownerId },
      { machineId: identity.machineId, deviceId: identity.deviceId, revision: identity.revision },
    ),
    cancel,
    dispose() {
      keys.dispose();
      cancel();
    },
  };
}
