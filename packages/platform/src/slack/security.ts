import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function verifySlackSignature(input: { secret: string; timestamp?: string; signature?: string; body: string; now: Date }): boolean {
  if (!input.secret || !input.timestamp || !/^\d{10,12}$/.test(input.timestamp) || !input.signature || !/^v0=[a-f0-9]{64}$/.test(input.signature)) return false;
  if (Math.abs(input.now.getTime() / 1_000 - Number(input.timestamp)) > 300) return false;
  const expected = createHmac("sha256", input.secret).update(`v0:${input.timestamp}:${input.body}`).digest();
  return timingSafeEqual(expected, Buffer.from(input.signature.slice(3), "hex"));
}

function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) throw new Error("Slack encryption unavailable");
  return key;
}

export function encryptSlackToken(token: string, encodedKey: string, context: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), iv);
  cipher.setAAD(Buffer.from(context));
  const content = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), content.toString("base64url")].join(".");
}

export function decryptSlackToken(encrypted: string, encodedKey: string, context: string): string {
  try {
    const [version, iv, tag, content, extra] = encrypted.split(".");
    if (version !== "v1" || !iv || !tag || !content || extra !== undefined) throw new Error("Invalid ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(content, "base64url")), decipher.final()]).toString("utf8");
  } catch (error: unknown) {
    console.warn("[slack] token decryption failed", error instanceof Error ? error.name : "UnknownError");
    throw new Error("Slack credentials unavailable");
  }
}

/** Plain-text messages cannot inject Slack mentions, broadcasts or link syntax. */
export function escapeSlackText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
