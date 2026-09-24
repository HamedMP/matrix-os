import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserLogin } from "./chromium-secrets";
import type { BrowserPasswordVault } from "./password-vault";
import { BrowserAccountChangedError } from "./account-scope";

const execFileAsync = promisify(execFile);
const MAX_ITEMS = 2_000;
const MAX_ACCOUNTS = 32;
const ITEM_ID = /^[A-Za-z0-9]{12,64}$/;
const ACCOUNT_ID = /^[A-Za-z0-9]{20,64}$/;

export interface OnePasswordAccount {
  id: string;
  label: string;
}

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
    if (typeof href !== "string" || href.length > 2_048 || !URL.canParse(href)) continue;
    const url = new URL(href);
    if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url.origin;
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
  } catch (error: unknown) {
    // CLI errors can contain item names, account identifiers, or paths.
    console.warn("[browser-import] 1Password CLI unavailable", error instanceof Error ? error.name : "unknown");
    throw new Error("1Password is unavailable or locked");
  }
}

export async function listOnePasswordAccounts(run: RunCli = runOnePasswordCli): Promise<OnePasswordAccount[]> {
  const value = await run(["account", "list", "--format", "json"]);
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error("1Password account list unavailable");
  const seen = new Set<string>();
  const accounts: OnePasswordAccount[] = [];
  for (const candidate of value) {
    const account = record(candidate);
    if (!account || typeof account.account_uuid !== "string" ||
      !ACCOUNT_ID.test(account.account_uuid) || seen.has(account.account_uuid)) continue;
    const email = typeof account.email === "string" ? account.email.slice(0, 256) : "";
    const url = typeof account.url === "string" ? account.url.slice(0, 256) : "";
    seen.add(account.account_uuid);
    accounts.push({ id: account.account_uuid, label: [email, url].filter(Boolean).join(" · ").slice(0, 320) || "1Password account" });
  }
  return accounts;
}

export async function listOnePasswordLogins(accountId: string, run: RunCli = runOnePasswordCli, signal?: AbortSignal): Promise<OnePasswordSummary[]> {
  if (!ACCOUNT_ID.test(accountId)) throw new Error("invalid 1Password account");
  const value = await run(["item", "list", "--categories", "Login", "--format", "json", "--account", accountId], signal);
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
  accountId: string,
  ids: string[],
  vault: BrowserPasswordVault,
  run: RunCli = runOnePasswordCli,
): Promise<{ imported: number; skipped: number }> {
  if (!ACCOUNT_ID.test(accountId) || !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_ITEMS || ids.some((id) => !ITEM_ID.test(id))) {
    throw new Error("invalid 1Password selection");
  }
  const signal = AbortSignal.timeout(180_000);
  const summaries = await listOnePasswordLogins(accountId, run, signal);
  const allowed = new Map(summaries.map((item) => [item.id, item.origin]));
  const unique = [...new Set(ids)];
  if (unique.some((id) => !allowed.has(id))) throw new Error("invalid 1Password selection");
  let pending: BrowserLogin[] = [];
  let imported = 0;
  for (const id of unique) {
    if (signal.aborted) break;
    let detail: unknown;
    try {
      detail = await run(["item", "get", id, "--format", "json", "--reveal", "--account", accountId], signal);
    } catch (error: unknown) {
      if (error instanceof BrowserAccountChangedError) throw error;
      console.warn("[browser-import] selected 1Password item unavailable", error instanceof Error ? error.name : "unknown");
      if (imported === 0 && pending.length === 0) throw new Error("1Password is unavailable or locked");
      break;
    }
    const login = parseOnePasswordLogin(detail);
    if (login && login.origin === allowed.get(id)) pending.push(login);
    if (pending.length >= 20) {
      try {
        await vault.upsertMany(pending);
      } catch (error: unknown) {
        if (error instanceof BrowserAccountChangedError) throw error;
        console.warn("[browser-import] 1Password batch could not be saved", error instanceof Error ? error.name : "unknown");
        if (imported === 0) throw new Error("browser password vault unavailable");
        return { imported, skipped: unique.length - imported };
      }
      imported += pending.length;
      pending = [];
    }
  }
  if (pending.length > 0) {
    try {
      await vault.upsertMany(pending);
    } catch (error: unknown) {
      if (error instanceof BrowserAccountChangedError) throw error;
      console.warn("[browser-import] final 1Password batch could not be saved", error instanceof Error ? error.name : "unknown");
      if (imported === 0) throw new Error("browser password vault unavailable");
      return { imported, skipped: unique.length - imported };
    }
    imported += pending.length;
  }
  return { imported, skipped: unique.length - imported };
}
