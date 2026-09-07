import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENVELOPE_VERSION = 1;

export interface CustomMcpCredentialBinding {
  userId: string;
  serverId: string;
}

function additionalData(binding: CustomMcpCredentialBinding): Buffer {
  return Buffer.from(
    `matrix-custom-mcp:v1:${binding.userId}:${binding.serverId}`,
    "utf8",
  );
}

export function parseCustomMcpEncryptionKey(
  value: string | undefined,
): Buffer {
  if (!value) {
    throw new Error("MCP_CREDENTIAL_ENCRYPTION_KEY is required");
  }

  const trimmed = value.trim();
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "hex");
  } else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    key = Buffer.from(trimmed, "base64");
  } else {
    key = Buffer.alloc(0);
  }
  if (key.length !== 32) {
    throw new Error("MCP_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

export function encryptCustomMcpCredential(
  credential: unknown,
  key: Buffer,
  binding: CustomMcpCredentialBinding,
): string {
  if (key.length !== 32) throw new Error("Custom MCP encryption key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(binding));
  const plaintext = Buffer.from(JSON.stringify(credential), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    `v${ENVELOPE_VERSION}`,
    nonce.toString("base64url"),
    ciphertext.toString("base64url"),
    tag.toString("base64url"),
  ].join(".");
}

export function decryptCustomMcpCredential<T = unknown>(
  envelope: string,
  key: Buffer,
  binding: CustomMcpCredentialBinding,
): T {
  if (key.length !== 32) throw new Error("Custom MCP encryption key must be 32 bytes");
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== `v${ENVELOPE_VERSION}`) {
    throw new Error("Unsupported Custom MCP credential envelope");
  }
  const nonce = Buffer.from(parts[1]!, "base64url");
  const ciphertext = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES) {
    throw new Error("Invalid Custom MCP credential envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
    authTagLength: TAG_BYTES,
  });
  decipher.setAAD(additionalData(binding));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
