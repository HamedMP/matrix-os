import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const CREDENTIAL_VERSION = 1;
const STATE_VERSION = 1;
const STATE_AAD = Buffer.from("matrix-os:github-oauth-state:v1", "utf8");

export interface GitHubCredentialBinding {
  userId: string;
  githubUserId: string;
}

function credentialAad(binding: GitHubCredentialBinding): Buffer {
  return Buffer.from(
    `matrix-os:github-credential:v1\0${binding.userId}\0${binding.githubUserId}`,
    "utf8",
  );
}

function encryptEnvelope(prefix: string, value: unknown, key: Buffer, aad: Buffer): string {
  if (key.length !== KEY_BYTES) throw new Error("GitHub credential encryption key must be 32 bytes");
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return [prefix, nonce.toString("base64url"), ciphertext.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}

function decryptEnvelope<T>(prefix: string, envelope: string, key: Buffer, aad: Buffer): T {
  if (key.length !== KEY_BYTES) throw new Error("GitHub credential encryption key must be 32 bytes");
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== prefix) throw new Error("Unsupported GitHub credential envelope");
  const nonce = Buffer.from(parts[1]!, "base64url");
  const ciphertext = Buffer.from(parts[2]!, "base64url");
  const tag = Buffer.from(parts[3]!, "base64url");
  if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES
    || nonce.toString("base64url") !== parts[1]
    || ciphertext.toString("base64url") !== parts[2]
    || tag.toString("base64url") !== parts[3]) {
    throw new Error("Invalid GitHub credential envelope");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as T;
}

export function parseGitHubCredentialEncryptionKey(value: string | undefined): Buffer {
  const trimmed = value?.trim() ?? "";
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, "hex");
  else if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) key = Buffer.from(trimmed, "base64");
  else key = Buffer.alloc(0);
  if (key.length !== KEY_BYTES) throw new Error("GITHUB_OAUTH_ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

export function encryptGitHubCredential(value: unknown, key: Buffer, binding: GitHubCredentialBinding): string {
  return encryptEnvelope(`g${CREDENTIAL_VERSION}`, value, key, credentialAad(binding));
}

export function decryptGitHubCredential<T = unknown>(envelope: string, key: Buffer, binding: GitHubCredentialBinding): T {
  return decryptEnvelope<T>(`g${CREDENTIAL_VERSION}`, envelope, key, credentialAad(binding));
}

export function encryptGitHubOAuthState(value: unknown, key: Buffer): string {
  return encryptEnvelope(`gs${STATE_VERSION}`, value, key, STATE_AAD);
}

export function decryptGitHubOAuthState<T = unknown>(envelope: string, key: Buffer): T {
  return decryptEnvelope<T>(`gs${STATE_VERSION}`, envelope, key, STATE_AAD);
}
