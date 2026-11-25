import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

export const BUNDLE_DIR = join(process.cwd(), "distro/messaging-bridge-host");
export const BOOTSTRAP = join(BUNDLE_DIR, "bootstrap.sh");
export const NETWORKS = ["whatsapp", "telegram", "linkedin"] as const;
export type Network = (typeof NETWORKS)[number];

export const TEST_INPUTS = {
  MBH_PUBLIC_HOSTNAME: "bridge.test.example",
  MBH_SERVER_NAME: "bridge.test.example",
  MBH_ACME_EMAIL: "ops@test.example",
  MBH_TELEGRAM_API_ID: "1234567",
  MBH_TELEGRAM_API_HASH: "0123456789abcdef0123456789abcdef",
};

export interface BootstrapRun {
  status: number | null;
  stdout: string;
  stderr: string;
}

export function makeStateDir(): string {
  return mkdtempSync(join(tmpdir(), "mbh-state-"));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function runBootstrap(stateDir: string, extraEnv: Record<string, string | undefined> = {}): BootstrapRun {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: stateDir,
    MBH_STATE_DIR: stateDir,
    MBH_RENDER_ONLY: "1",
    ...TEST_INPUTS,
  };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync("bash", [BOOTSTRAP], { env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function readSecret(stateDir: string, name: string): string {
  return readFileSync(join(stateDir, "secrets", name), "utf8").trim();
}

export function listSecretValues(stateDir: string): string[] {
  return readdirSync(join(stateDir, "secrets"))
    .map((name) => readSecret(stateDir, name))
    .filter((value) => value.length >= 8);
}

export function readYaml<T = Record<string, unknown>>(path: string): T {
  return parse(readFileSync(path, "utf8")) as T;
}

export function mode(path: string): number {
  return statSync(path).mode & 0o777;
}
