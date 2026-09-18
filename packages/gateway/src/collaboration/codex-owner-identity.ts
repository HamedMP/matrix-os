import { randomUUID } from "node:crypto";
import { constants, lstat, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod/v4";

const MAX_AUTH_BYTES = 1024 * 1024;
const MAX_REFRESH_BYTES = 64 * 1024;
const REFRESH_WINDOW_MS = 5 * 60 * 1000;
const FALLBACK_REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000;
const REFRESH_URL = "https://auth.openai.com/oauth/token";
const OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SAFE_ERROR = "Codex owner identity unavailable";

const ApiKeyAuthSchema = z.object({
  auth_mode: z.literal("apikey").optional(),
  OPENAI_API_KEY: z.string().min(1).max(16_384),
}).passthrough();
const ChatGptAuthSchema = z.object({
  auth_mode: z.literal("chatgpt").optional(),
  tokens: z.object({
    id_token: z.string().min(1).max(64 * 1024).optional(),
    access_token: z.string().min(1).max(64 * 1024),
    refresh_token: z.string().min(1).max(64 * 1024),
    account_id: z.string().min(1).max(512).optional(),
  }).passthrough(),
  last_refresh: z.string().datetime().optional(),
}).passthrough();

export interface CodexOwnerIdentity {
  url: string;
  headers: Record<string, string>;
}

function unavailable(): Error {
  return new Error(SAFE_ERROR);
}

async function readAuth(path: string): Promise<Record<string, unknown>> {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw unavailable();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_AUTH_BYTES) throw unavailable();
    const value: unknown = JSON.parse(await handle.readFile("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
    return value as Record<string, unknown>;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) throw unavailable();
    throw error;
  } finally {
    await handle.close();
  }
}

function jwtClaims(token: string): Record<string, unknown> | undefined {
  try {
    const encoded = token.split(".")[1];
    if (!encoded) return undefined;
    const payload: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : undefined;
  } catch (error: unknown) {
    if (!(error instanceof Error)) throw unavailable();
    return undefined;
  }
}

function jwtExpiry(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isSafeInteger(exp) ? exp * 1000 : undefined;
}

function chatGptAccountId(auth: z.infer<typeof ChatGptAuthSchema>): string {
  const accountId = auth.tokens.account_id
    ?? (auth.tokens.id_token ? jwtClaims(auth.tokens.id_token)?.chatgpt_account_id : undefined);
  if (typeof accountId !== "string" || accountId.length < 1 || accountId.length > 512) {
    throw unavailable();
  }
  return accountId;
}

function needsRefresh(auth: z.infer<typeof ChatGptAuthSchema>, now: number): boolean {
  const expiry = jwtExpiry(auth.tokens.access_token);
  if (expiry !== undefined) return expiry <= now + REFRESH_WINDOW_MS;
  const lastRefresh = auth.last_refresh ? Date.parse(auth.last_refresh) : Number.NaN;
  return Number.isFinite(lastRefresh) && lastRefresh < now - FALLBACK_REFRESH_AGE_MS;
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_REFRESH_BYTES) throw unavailable();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_REFRESH_BYTES) throw unavailable();
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

async function writeAuth(path: string, value: Record<string, unknown>): Promise<void> {
  const temporary = join(dirname(path), `.auth.json.matrix-${randomUUID()}`);
  try {
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: unknown) => {
      if (!(error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    });
  }
}

export type ResolveCodexOwnerIdentity = (
  signal: AbortSignal,
  forceRefresh?: boolean,
) => Promise<CodexOwnerIdentity>;

export function createCodexOwnerIdentityResolver(options: {
  homePath: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): ResolveCodexOwnerIdentity {
  const path = join(options.homePath, ".codex", "auth.json");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  let refreshInFlight: Promise<Record<string, unknown>> | undefined;

  const refresh = async (auth: z.infer<typeof ChatGptAuthSchema>, signal: AbortSignal) => {
    const response = await fetchImpl(REFRESH_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: auth.tokens.refresh_token,
      }),
      redirect: "error",
      signal,
    });
    const text = await boundedText(response);
    if (!response.ok) throw unavailable();
    const refreshed = z.object({
      access_token: z.string().min(1).max(64 * 1024).optional(),
      refresh_token: z.string().min(1).max(64 * 1024).optional(),
      id_token: z.string().min(1).max(64 * 1024).optional(),
    }).parse(JSON.parse(text));
    const current = ChatGptAuthSchema.parse(await readAuth(path));
    if (current.tokens.refresh_token !== auth.tokens.refresh_token
      || chatGptAccountId(current) !== chatGptAccountId(auth)) return current;
    const next: Record<string, unknown> = {
      ...current,
      tokens: {
        ...current.tokens,
        ...(refreshed.access_token ? { access_token: refreshed.access_token } : {}),
        ...(refreshed.refresh_token ? { refresh_token: refreshed.refresh_token } : {}),
        ...(refreshed.id_token ? { id_token: refreshed.id_token } : {}),
      },
      last_refresh: new Date(now()).toISOString(),
    };
    await writeAuth(path, next);
    return next;
  };

  return async (signal, forceRefresh = false) => {
    try {
      signal.throwIfAborted();
      let raw = await readAuth(path);
      const apiKey = ApiKeyAuthSchema.safeParse(raw);
      if (apiKey.success && (raw.auth_mode === "apikey" || raw.auth_mode === undefined)) {
        return {
          url: "https://api.openai.com/v1/responses",
          headers: { authorization: `Bearer ${apiKey.data.OPENAI_API_KEY}` } as Record<string, string>,
        };
      }
      let chatgpt = ChatGptAuthSchema.parse(raw);
      if (raw.auth_mode !== "chatgpt" && raw.auth_mode !== undefined) throw unavailable();
      if (forceRefresh || needsRefresh(chatgpt, now())) {
        refreshInFlight ??= refresh(chatgpt, signal).finally(() => { refreshInFlight = undefined; });
        raw = await refreshInFlight;
        chatgpt = ChatGptAuthSchema.parse(raw);
      }
      signal.throwIfAborted();
      return {
        url: "https://chatgpt.com/backend-api/codex/responses",
        headers: {
          authorization: `Bearer ${chatgpt.tokens.access_token}`,
          "chatgpt-account-id": chatGptAccountId(chatgpt),
        } as Record<string, string>,
      };
    } catch (error: unknown) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof Error && error.message === SAFE_ERROR) throw error;
      throw unavailable();
    }
  };
}
