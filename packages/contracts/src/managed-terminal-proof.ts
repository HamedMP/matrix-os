import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export const MANAGED_TERMINAL_TIMESTAMP_HEADER = "x-matrix-terminal-time";
export const MANAGED_TERMINAL_NONCE_HEADER = "x-matrix-terminal-nonce";
const SIGNATURE_HEADER = "x-matrix-terminal-proof";
const TTL_MS = 15_000;
const CLOCK_SKEW_MS = 1_000;
const MAX_SEEN_PROOFS = 2048;
const noncePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hexProof = /^[0-9a-f]{64}$/;
type Direction = "source" | "target";
type SealedDirection = "target" | "target-response";

export function managedWorkspaceIdFor(machineId: string) {
  return "tws_6d6774" + createHash("sha256").update(machineId).digest("hex").slice(0, 26);
}

export function managedTerminalBodyDigest(canonicalBodyJson: string) {
  return createHash("sha256").update(canonicalBodyJson).digest("hex");
}

function sealingKey(token: string, direction: SealedDirection) {
  return createHmac("sha256", token).update(`matrix-terminal-control.v1.seal.${direction}`).digest();
}

/** The existing IP-based VPS hop may lack authenticated TLS. Protect bytes separately there. */
export function sealManagedTerminalPayload(token: string, direction: SealedDirection, json: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(token, direction), iv);
  const ciphertext = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  return JSON.stringify(Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url"));
}

export function openManagedTerminalPayload(token: string, direction: SealedDirection, raw: string): string | null {
  if (!/^"[A-Za-z0-9_-]+"$/.test(raw)) return null;
  const encoded = raw.slice(1, -1);
  const payload = Buffer.from(encoded, "base64url");
  if (payload.length <= 28 || payload.toString("base64url") !== encoded) return null;
  const decipher = createDecipheriv("aes-256-gcm", sealingKey(token, direction), payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
  } catch (error: unknown) {
    if (error instanceof Error) return null;
    throw error;
  }
}

function signature(token: string, direction: Direction | "target-response", issuedAt: number, nonce: string, raw: string) {
  return createHmac("sha256", token).update(`matrix-terminal-control.v1.${direction}.${issuedAt}.${nonce}.`).update(raw).digest();
}

export function createManagedTerminalReplyHeaders(token: string, raw: string, status: number, issuedAt: number, nonce: string) {
  return {
    "content-type": "application/json",
    "cache-control": "no-store",
    [SIGNATURE_HEADER]: signature(token, "target-response", issuedAt, nonce, `${status}.${raw}`).toString("hex"),
  };
}

export function verifyManagedTerminalReply(token: string, response: Response, raw: string, issuedAt: number, nonce: string) {
  const proof = response.headers.get(SIGNATURE_HEADER) ?? "";
  if (!hexProof.test(proof) || !hexProof.test(token) || !noncePattern.test(nonce)) return false;
  return timingSafeEqual(
    signature(token, "target-response", issuedAt, nonce, `${response.status}.${raw}`),
    Buffer.from(proof, "hex"),
  );
}

export function createManagedTerminalHeaders(
  token: string, direction: Direction, raw: string,
  options: { issuedAt?: number; nonce?: string } = {},
): Record<string, string> {
  const issuedAt = options.issuedAt ?? Date.now();
  const nonce = options.nonce ?? randomUUID();
  return {
    "content-type": "application/json",
    [MANAGED_TERMINAL_TIMESTAMP_HEADER]: String(issuedAt),
    [MANAGED_TERMINAL_NONCE_HEADER]: nonce,
    [SIGNATURE_HEADER]: signature(token, direction, issuedAt, nonce, raw).toString("hex"),
  };
}

/** One verifier across each route's process lifetime. Never evict still-live nonces. */
export function createManagedTerminalVerifier({ direction, now = Date.now }: { direction: Direction; now?: () => number }) {
  const seen = new Map<string, number>();
  return (request: Request, token: string, raw: string): AbortSignal | null => {
    const time = request.headers.get(MANAGED_TERMINAL_TIMESTAMP_HEADER) ?? "";
    const nonce = request.headers.get(MANAGED_TERMINAL_NONCE_HEADER) ?? "";
    const proof = request.headers.get(SIGNATURE_HEADER) ?? "";
    if (!/^\d{13}$/.test(time) || !noncePattern.test(nonce) || !hexProof.test(proof) || !hexProof.test(token)) return null;
    const issuedAt = Number(time);
    const current = now();
    const expires = issuedAt + TTL_MS;
    if (issuedAt - current > CLOCK_SKEW_MS || current >= expires) return null;
    if (!timingSafeEqual(signature(token, direction, issuedAt, nonce, raw), Buffer.from(proof, "hex"))) return null;
    for (const [key, deadline] of seen) if (current >= deadline) seen.delete(key);
    if (seen.has(nonce) || seen.size >= MAX_SEEN_PROOFS) return null;
    seen.set(nonce, expires);
    return AbortSignal.timeout(expires - current);
  };
}

/** Read no more than the route's JSON response budget, even with a chunked body. */
export async function readManagedTerminalResponseText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Managed terminal response unavailable");
  const chunks: Uint8Array[] = [];
  let count = 0;
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      count += chunk.value.byteLength;
      if (count > maxBytes) {
        await reader.cancel();
        throw new Error("Managed terminal response too large");
      }
      chunks.push(chunk.value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export async function readManagedTerminalResponse(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readManagedTerminalResponseText(response, maxBytes));
}
