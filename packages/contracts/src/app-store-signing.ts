import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { canonicalJson, type AppStoreManifest } from "./app-store.js";

/** Reviewed source identity; presigned URLs are transport, never part of approval. */
export interface StoreApprovalPayload {
  versionId: string;
  version: string;
  source: { sha256: string; size: number };
  capabilitiesDigest: string;
  manifest: AppStoreManifest;
}
export interface StoreApproval { keyId: string; signature: string }
export interface StoreSigningKey { keyId: string; publicKey: string }

function message(payload: StoreApprovalPayload): Buffer {
  return Buffer.from(canonicalJson({
    domain: "matrix-app-store-source/v1", versionId: payload.versionId, version: payload.version,
    source: { sha256: payload.source.sha256, size: payload.source.size },
    capabilitiesDigest: payload.capabilitiesDigest, manifest: payload.manifest,
  }));
}

export function signStoreApproval(payload: StoreApprovalPayload, key: { keyId: string; privateKey: string }): StoreApproval {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key.keyId)) throw new Error("Invalid store signing key");
  const privateKey = createPrivateKey(key.privateKey);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid store signing key");
  return { keyId: key.keyId, signature: sign(null, message(payload), privateKey).toString("base64url") };
}

/** Keys must come from the authenticated configured platform, never the bundle. */
export function verifyStoreApproval(payload: StoreApprovalPayload, approval: StoreApproval, keys: readonly StoreSigningKey[]): boolean {
  if (!/^[A-Za-z0-9_-]{86}$/.test(approval.signature) || keys.length > 4) return false;
  const key = keys.find(candidate => candidate.keyId === approval.keyId);
  if (!key || key.publicKey.length > 1024) return false;
  try {
    const publicKey = createPublicKey(key.publicKey);
    return publicKey.asymmetricKeyType === "ed25519"
      && verify(null, message(payload), publicKey, Buffer.from(approval.signature, "base64url"));
  } catch (error: unknown) {
    if (error instanceof Error) return false;
    throw error;
  }
}
