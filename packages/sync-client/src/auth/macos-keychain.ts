import { spawn } from "node:child_process";
import { z } from "zod/v4";
import { AuthDataSchema, type AuthData } from "./schema.js";

const SECURITY_PATH = "/usr/bin/security";
const KEYCHAIN_SERVICE = "com.matrix-os.sync";
const KEYCHAIN_TIMEOUT_MS = 10_000;
const MAX_KEYCHAIN_OUTPUT_BYTES = 32 * 1024;
const KeychainAccountSchema = z.uuid();

export interface KeychainCommandResult {
  stdout: string;
  stderr: string;
}

export type KeychainCommandRunner = (
  command: string,
  args: string[],
  input?: string,
) => Promise<KeychainCommandResult>;

export interface MacKeychainAuthStore {
  get(account: string): Promise<AuthData | null>;
  set(account: string, auth: AuthData): Promise<void>;
  delete(account: string): Promise<void>;
}

function commandError(exitCode: number | null): Error & { exitCode: number | null } {
  return Object.assign(new Error("macOS Keychain command failed"), { exitCode });
}

export function runKeychainCommand(
  command: string,
  args: string[],
  input?: string,
): Promise<KeychainCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > MAX_KEYCHAIN_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("macOS Keychain response too large")));
      }
      return next;
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (err) => finish(() => reject(err)));
    child.on("exit", (code) => finish(() => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(commandError(code));
    }));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error("macOS Keychain command timed out")));
    }, KEYCHAIN_TIMEOUT_MS);
    child.stdin.end(input);
  });
}

export function createMacKeychainAuthStore(options: {
  run?: KeychainCommandRunner;
} = {}): MacKeychainAuthStore {
  const run = options.run ?? runKeychainCommand;
  return {
    async get(rawAccount) {
      const account = KeychainAccountSchema.parse(rawAccount);
      let result: KeychainCommandResult;
      try {
        result = await run(SECURITY_PATH, [
          "find-generic-password",
          "-a",
          account,
          "-s",
          KEYCHAIN_SERVICE,
          "-w",
        ], undefined);
      } catch (err: unknown) {
        if (err instanceof Error && "exitCode" in err && err.exitCode === 44) return null;
        throw err;
      }
      try {
        const encoded = result.stdout.trim();
        if (!/^[A-Za-z0-9_-]{1,32768}$/.test(encoded)) throw new Error("invalid encoding");
        return AuthDataSchema.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
      } catch {
        throw new Error("macOS Keychain credential is invalid");
      }
    },

    async set(rawAccount, rawAuth) {
      const account = KeychainAccountSchema.parse(rawAccount);
      const auth = AuthDataSchema.parse(rawAuth);
      const encoded = Buffer.from(JSON.stringify(auth), "utf8").toString("base64url");
      await run(
        SECURITY_PATH,
        ["-i"],
        `add-generic-password -U -a ${account} -s ${KEYCHAIN_SERVICE} -w ${encoded}\n`,
      );
    },

    async delete(rawAccount) {
      const account = KeychainAccountSchema.parse(rawAccount);
      try {
        await run(SECURITY_PATH, [
          "delete-generic-password",
          "-a",
          account,
          "-s",
          KEYCHAIN_SERVICE,
        ], undefined);
      } catch (err: unknown) {
        if (err instanceof Error && "exitCode" in err && err.exitCode === 44) return;
        throw err;
      }
    },
  };
}
