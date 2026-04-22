import { readFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { defineCommand } from "citty";
import { writeUtf8FileAtomic } from "../../lib/atomic-write.js";

const SUPPORTED_KEY_TYPES = ["ssh-ed25519", "ssh-rsa", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521"] as const;
type KeyType = (typeof SUPPORTED_KEY_TYPES)[number];

export interface PublicKey {
  type: KeyType;
  data: string;
  comment: string;
}

type ValidationResult = { valid: true } | { valid: false; reason: string };

export function parsePublicKey(raw: string): PublicKey | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("-----")) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return null;
  }

  const type = parts[0] as string;
  if (!SUPPORTED_KEY_TYPES.includes(type as KeyType)) {
    return null;
  }

  const data = parts[1]!;
  const comment = parts.slice(2).join(" ");

  return { type: type as KeyType, data, comment };
}

export function validatePublicKey(key: PublicKey): ValidationResult {
  if (!key.data || key.data.length === 0) {
    return { valid: false, reason: "Key data is empty" };
  }

  // Check base64 validity
  const base64Regex = /^[A-Za-z0-9+/]+=*$/;
  if (!base64Regex.test(key.data)) {
    return { valid: false, reason: "Key data is not valid base64" };
  }

  return { valid: true };
}

export function formatAuthorizedKeysEntry(key: PublicKey): string {
  if (key.comment) {
    return `${key.type} ${key.data} ${key.comment}`;
  }
  return `${key.type} ${key.data}`;
}

export async function addKeyToAuthorizedKeys(
  filePath: string,
  key: PublicKey,
): Promise<void> {
  const entry = formatAuthorizedKeysEntry(key);

  await mkdir(dirname(filePath), { recursive: true });

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (!(err instanceof Error) || (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const lines = existing.trim().split("\n").filter((l) => l.length > 0);

  // Check for duplicate by comparing type + data (ignore comment)
  const isDuplicate = lines.some((line) => {
    const parsed = parsePublicKey(line);
    return parsed !== null && parsed.type === key.type && parsed.data === key.data;
  });

  if (isDuplicate) {
    return;
  }

  lines.push(entry);
  await writeUtf8FileAtomic(filePath, lines.join("\n") + "\n", 0o600);
}

const addKeyCommand = defineCommand({
  meta: { name: "add", description: "Add an SSH public key" },
  args: {
    pubkeyFile: {
      type: "positional",
      description: "Path to the public key file",
      required: true,
    },
  },
  run: async ({ args }) => {
    const raw = await readFile(args.pubkeyFile, "utf-8");
    const key = parsePublicKey(raw);
    if (!key) {
      console.error("Invalid public key format. Supported types: ed25519, RSA, ECDSA");
      process.exitCode = 1;
      return;
    }

    const validation = validatePublicKey(key);
    if (!validation.valid) {
      console.error(`Invalid key: ${validation.reason}`);
      process.exitCode = 1;
      return;
    }

    const authorizedKeysPath = resolve(homedir(), "matrixos", "system", "authorized_keys");
    await addKeyToAuthorizedKeys(authorizedKeysPath, key);
    console.log(`Added ${key.type} key${key.comment ? ` (${key.comment})` : ""}`);
  },
});

export const keysCommand = defineCommand({
  meta: { name: "keys", description: "Manage SSH keys" },
  subCommands: {
    add: addKeyCommand,
  },
});
