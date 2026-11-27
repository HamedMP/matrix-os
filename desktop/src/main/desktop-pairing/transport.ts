import {
  DesktopPairingChallengeSchema,
  DesktopPairingStateSchema,
  desktopPairingRevisionTag,
} from "@matrix-os/contracts";
import type { z } from "zod/v4";
import type { AuthService } from "../auth/auth-service";

const PAIRING_PATH = "/api/desktop-pairing";
const TIMEOUT_MS = 10_000;
const MAX_REPLY_BYTES = 4096;
const MAX_REPLY_CHUNKS = 256;

export type PairingAuth = Pick<AuthService, "getStatus" | "getToken" | "getGatewayOrigin">;
export type PairingState = z.infer<typeof DesktopPairingStateSchema>;

export function matchingPairingState(a: PairingState, b: PairingState): boolean {
  return a.machineId === b.machineId && a.deviceId === b.deviceId && a.revision === b.revision;
}

interface Authority {
  origin: string;
  ownerId: string;
  handle: string;
  generation: number;
  token: string;
}

function currentAuthority(auth: PairingAuth): Authority | null {
  const status = auth.getStatus();
  const token = auth.getToken();
  if (!status.signedIn || status.runtimeSlot !== "primary" || !token) return null;
  const origin = URL.parse(auth.getGatewayOrigin());
  if (!origin || origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash
      || origin.username || origin.password || origin.origin !== status.platformHost.replace(/\/$/, "")) return null;
  return { origin: origin.origin, ownerId: status.userId, handle: status.handle, generation: status.authGeneration, token };
}

async function readPairingReply(response: Response, signal: AbortSignal) {
  const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (!response.ok || mediaType !== "application/json" || !response.body
      || Number(response.headers.get("content-length")) > MAX_REPLY_BYTES) {
    await response.body?.cancel();
    throw new Error("Pairing response unavailable");
  }

  const reader = response.body.getReader();
  const bytes = Buffer.alloc(MAX_REPLY_BYTES);
  let offset = 0;
  let chunks = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) return JSON.parse(bytes.subarray(0, offset).toString("utf8")) as unknown;
      if (++chunks > MAX_REPLY_CHUNKS || offset + value.byteLength > bytes.length) {
        throw new Error("Pairing response too large");
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    try {
      await reader.cancel();
    } catch (error: unknown) {
      if (!signal.aborted) throw error;
    } finally {
      reader.releaseLock();
    }
  }
}

export function createPairingTransport(auth: PairingAuth, fetchFn: typeof fetch, signal: AbortSignal) {
  const authority = currentAuthority(auth);
  if (!authority) return null;
  const { origin, ownerId, handle, generation, token } = authority;
  function assertCurrent() {
    signal.throwIfAborted();
    const active = currentAuthority(auth);
    if (!active || active.origin !== origin || active.handle !== handle || active.ownerId !== ownerId
        || active.generation !== generation || active.token !== token) {
      throw new Error("Pairing session changed");
    }
  }

  async function request(path: string, method: string, options: {
    body?: object; ifMatch?: string; signal?: AbortSignal;
  } = {}) {
    assertCurrent();
    const { body, ifMatch } = options;
    const signals = [signal, AbortSignal.timeout(TIMEOUT_MS)];
    if (options.signal) signals.push(options.signal);
    const requestSignal = AbortSignal.any(signals);
    requestSignal.throwIfAborted();
    const response = await fetchFn(new URL(path, origin), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(ifMatch === undefined ? {} : { "If-Match": ifMatch }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      cache: "no-store",
      signal: requestSignal,
    });
    try {
      requestSignal.throwIfAborted();
      assertCurrent();
    } catch (error: unknown) {
      await response.body?.cancel();
      throw error;
    }
    const result = await readPairingReply(response, requestSignal);
    assertCurrent();
    return result;
  }

  return {
    origin,
    ownerId,
    assertCurrent,
    async read(signal?: AbortSignal) {
      return DesktopPairingStateSchema.parse(await request(PAIRING_PATH, "GET", { signal }));
    },
    async challenge(deviceId: string, revision: number) {
      return DesktopPairingChallengeSchema.parse(await request(`${PAIRING_PATH}/challenge`, "POST", { body: { deviceId, revision } }));
    },
    async pair(proof: { nonce: string; publicKey: string; signature: string }) {
      return DesktopPairingStateSchema.parse(await request(`${PAIRING_PATH}/pair`, "POST", { body: proof }));
    },
    async revoke(state: { machineId: string; deviceId: string; revision: number }) {
      return DesktopPairingStateSchema.parse(await request(
        `${PAIRING_PATH}/${encodeURIComponent(state.deviceId)}`, "DELETE",
        { body: { revision: state.revision }, ifMatch: desktopPairingRevisionTag(state) },
      ));
    },
  };
}
