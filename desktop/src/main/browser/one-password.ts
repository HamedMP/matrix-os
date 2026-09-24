import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserLogin } from "./chromium-secrets";
import type { BrowserPasswordVault } from "./password-vault";

const execFileAsync = promisify(execFile);
const MAX_ITEMS = 2_000;
const ITEM_ID = /^[A-Za-z0-9]{12,64}$/;

export interface OnePasswordSummary {
  id: string;
  title: string;
  origin: string;
}

type RunCli = (args: string[], signal?: AbortSignal) => Promise<unknown>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function originFromItem(value: Record<string, unknown>): string | null {
  const urls = Array.isArray(value.urls) ? value.urls : [];
  for (const candidate of urls.slice(0, 16)) {
    const href = record(candidate)?.href;
    if (typeof href !== "string" || href.length > 2_048) continue;
    try {
      const url = new URL(href);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.origin;
    } catch {
      // Another URL on this item may be a usable website.
    }
  }
  return null;
}

/** Only Login fields are imported; OTP and arbitrary concealed fields are excluded. */
export function parseOnePasswordLogin(value: unknown): BrowserLogin | null {
  const item = record(value);
  if (!item || !["LOGIN", "Login"].includes(String(item.category))) return null;
  const origin = originFromItem(item);
  if (!origin || !Array.isArray(item.fields)) return null;
  const fields = item.fields.slice(0, 128).map(record).filter((field): field is Record<string, unknown> => field !== null);
  const username = fields.find((field) => field.id === "username" || field.purpose === "USERNAME")?.value;
  const password = fields.find((field) => field.id === "password" || field.purpose === "PASSWORD")?.value;
  if (typeof username !== "string" || !username || username.length > 512 ||
    typeof password !== "string" || !password || password.length > 64 * 1024) return null;
  return { origin, username, password };
}

export async function runOnePasswordCli(args: string[], signal?: AbortSignal): Promise<unknown> {
  try {
    const options = {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OP_BIOMETRIC_UNLOCK_ENABLED: "true" },
      signal,
    };
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("op", args, options));
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.platform !== "darwin") throw error;
      try {
        ({ stdout } = await execFileAsync("/opt/homebrew/bin/op", args, options));
      } catch (fallbackError: unknown) {
        if ((fallbackError as NodeJS.ErrnoException).code !== "ENOENT") throw fallbackError;
        ({ stdout } = await execFileAsync("/usr/local/bin/op", args, options));
      }
    }
    return JSON.parse(stdout) as unknown;
  } catch {
    // CLI errors can contain item names, account identifiers, or paths.
    throw new Error("1Password is unavailable or locked");
  }
}

export async function listOnePasswordLogins(run: RunCli = runOnePasswordCli, signal?: AbortSignal): Promise<OnePasswordSummary[]> {
  const value = await run(["item", "list", "--categories", "Login", "--format", "json"], signal);
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error("1Password list unavailable");
  const seen = new Set<string>();
  const items: OnePasswordSummary[] = [];
  for (const candidate of value) {
    const item = record(candidate);
    if (!item || typeof item.id !== "string" || !ITEM_ID.test(item.id) || seen.has(item.id)) continue;
    const origin = originFromItem(item);
    if (!origin) continue;
    seen.add(item.id);
    items.push({ id: item.id, title: typeof item.title === "string" ? item.title.slice(0, 256) : origin, origin });
  }
  return items;
}

export async function importOnePasswordLogins(
  ids: string[],
  vault: BrowserPasswordVault,
  run: RunCli = runOnePasswordCli,
): Promise<{ imported: number; skipped: number }> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS || ids.some((id) => !ITEM_ID.test(id))) {
    throw new Error("invalid 1Password selection");
  }
  const signal = AbortSignal.timeout(180_000);
  const summaries = await listOnePasswordLogins(run, signal);
  const allowed = new Map(summaries.map((item) => [item.id, item.origin]));
  const unique = [...new Set(ids)];
  if (unique.some((id) => !allowed.has(id))) throw new Error("invalid 1Password selection");
  const logins: BrowserLogin[] = [];
  for (const id of unique) {
    signal.throwIfAborted();
    const detail = await run(["item", "get", id, "--format", "json", "--reveal"], signal);
    const login = parseOnePasswordLogin(detail);
    if (login && login.origin === allowed.get(id)) logins.push(login);
  }
  if (logins.length > 0) await vault.upsertMany(logins);
  return { imported: logins.length, skipped: unique.length - logins.length };
}
