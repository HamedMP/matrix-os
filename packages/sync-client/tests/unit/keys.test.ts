import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parsePublicKey,
  validatePublicKey,
  formatAuthorizedKeysEntry,
  addKeyToAuthorizedKeys,
  type PublicKey,
} from "../../src/cli/commands/keys.js";

const TEST_DIR = join(import.meta.dirname, ".tmp-keys-test");

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true });
});

// Example keys for testing (not real private keys, just public key format)
const ED25519_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl user@host";
const RSA_KEY =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQC7vbqajDRyUaQr+G0xHC6r3mXUGGBJRMKF9yESfHSkHfGfPJIjVGEpOcP7GDXZ3JKT5V5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5K5Q== user@host";
const ECDSA_KEY =
  "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg= user@host";

describe("parsePublicKey", () => {
  it("parses an ed25519 key", () => {
    const key = parsePublicKey(ED25519_KEY);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ssh-ed25519");
    expect(key!.comment).toBe("user@host");
  });

  it("parses an RSA key", () => {
    const key = parsePublicKey(RSA_KEY);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ssh-rsa");
    expect(key!.comment).toBe("user@host");
  });

  it("parses an ECDSA key", () => {
    const key = parsePublicKey(ECDSA_KEY);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ecdsa-sha2-nistp256");
  });

  it("parses a key without a comment", () => {
    const keyNoComment =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    const key = parsePublicKey(keyNoComment);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ssh-ed25519");
    expect(key!.comment).toBe("");
  });

  it("returns null for empty string", () => {
    expect(parsePublicKey("")).toBeNull();
  });

  it("returns null for a private key", () => {
    expect(parsePublicKey("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parsePublicKey("not a key at all")).toBeNull();
  });

  it("returns null for an unsupported key type", () => {
    expect(parsePublicKey("ssh-dss AAAA... user@host")).toBeNull();
  });

  it("trims whitespace from the key string", () => {
    const key = parsePublicKey(`  ${ED25519_KEY}  \n`);
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ssh-ed25519");
  });
});

describe("validatePublicKey", () => {
  it("accepts a valid ed25519 key", () => {
    const key = parsePublicKey(ED25519_KEY)!;
    expect(validatePublicKey(key)).toEqual({ valid: true });
  });

  it("accepts a valid RSA key", () => {
    const key = parsePublicKey(RSA_KEY)!;
    expect(validatePublicKey(key)).toEqual({ valid: true });
  });

  it("accepts a valid ECDSA key", () => {
    const key = parsePublicKey(ECDSA_KEY)!;
    expect(validatePublicKey(key)).toEqual({ valid: true });
  });

  it("rejects a key with invalid base64 data", () => {
    const key: PublicKey = { type: "ssh-ed25519", data: "not!valid!base64!", comment: "" };
    const result = validatePublicKey(key);
    expect(result.valid).toBe(false);
  });

  it("rejects a key with empty data", () => {
    const key: PublicKey = { type: "ssh-ed25519", data: "", comment: "" };
    const result = validatePublicKey(key);
    expect(result.valid).toBe(false);
  });
});

describe("formatAuthorizedKeysEntry", () => {
  it("formats a key as an authorized_keys line", () => {
    const key = parsePublicKey(ED25519_KEY)!;
    const line = formatAuthorizedKeysEntry(key);
    expect(line).toBe(ED25519_KEY);
  });

  it("formats a key without comment", () => {
    const key: PublicKey = {
      type: "ssh-ed25519",
      data: "AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl",
      comment: "",
    };
    const line = formatAuthorizedKeysEntry(key);
    expect(line).toBe("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl");
  });
});

describe("addKeyToAuthorizedKeys", () => {
  it("creates the file if it does not exist", async () => {
    const filePath = join(TEST_DIR, "system", "authorized_keys");
    const key = parsePublicKey(ED25519_KEY)!;

    await addKeyToAuthorizedKeys(filePath, key);

    const content = await readFile(filePath, "utf-8");
    expect(content).toContain("ssh-ed25519");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("appends to an existing file", async () => {
    const filePath = join(TEST_DIR, "authorized_keys");
    await writeFile(filePath, `${RSA_KEY}\n`);

    const key = parsePublicKey(ED25519_KEY)!;
    await addKeyToAuthorizedKeys(filePath, key);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("ssh-rsa");
    expect(lines[1]).toContain("ssh-ed25519");
  });

  it("does not duplicate an existing key", async () => {
    const filePath = join(TEST_DIR, "authorized_keys");
    await writeFile(filePath, `${ED25519_KEY}\n`);

    const key = parsePublicKey(ED25519_KEY)!;
    await addKeyToAuthorizedKeys(filePath, key);

    const content = await readFile(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("reads a key from a file path", async () => {
    const keyFilePath = join(TEST_DIR, "id_ed25519.pub");
    await writeFile(keyFilePath, ED25519_KEY + "\n");

    const content = await readFile(keyFilePath, "utf-8");
    const key = parsePublicKey(content.trim());
    expect(key).not.toBeNull();
    expect(key!.type).toBe("ssh-ed25519");
  });
});
