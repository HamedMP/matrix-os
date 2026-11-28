import { createHash, createPublicKey, verify } from "node:crypto";

/** True only for a valid Ed25519 signature by the key whose SHA-256 is `deviceId`. */
export function verifyDeviceProof(deviceId: string, encodedPublicKey: string, encodedSignature: string, message: string): boolean {
  const publicKey = Buffer.from(encodedPublicKey, "base64url");
  const signature = Buffer.from(encodedSignature, "base64url");
  if (publicKey.toString("base64url") !== encodedPublicKey || signature.toString("base64url") !== encodedSignature
      || createHash("sha256").update(publicKey).digest("hex") !== deviceId) return false;
  try {
    const key = createPublicKey({ key: publicKey, type: "spki", format: "der" });
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(message), key, signature);
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && typeof error.code === "string"
        && error.code.startsWith("ERR_OSSL_")) return false;
    throw error;
  }
}
