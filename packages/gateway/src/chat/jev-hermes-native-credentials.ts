import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod/v4";
import type { JevHermesProvider, ProviderSettingsSnapshot } from "@matrix-os/contracts";
import type { AgentRuntimeSource } from "../agent-config/service.js";
import type { JevHermesCredentials } from "./jev-hermes-credentials.js";

const endpoints = {
  anthropic: { url: "https://api.anthropic.com", mode: "anthropic_messages", key: "ANTHROPIC_API_KEY" },
  "openai-api": { url: "https://api.openai.com/v1", mode: "codex_responses", key: "OPENAI_API_KEY" },
  openrouter: { url: "https://openrouter.ai/api/v1", mode: "chat_completions", key: "OPENROUTER_API_KEY" },
  "openai-codex": { url: "https://chatgpt.com/backend-api/codex", mode: "codex_responses", key: null },
} as const;
const Key = z.string().trim().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const Config = z.object({ model: z.object({ provider: z.string(), default: z.string(),
  base_url: z.string().optional(), api_mode: z.string().optional(), api_key: z.unknown().optional(),
  key_env: z.unknown().optional(), api_key_env: z.unknown().optional(), openai_runtime: z.unknown().optional(),
}).passthrough() }).passthrough();
const denied = () => new Error("Selected Inbox model setup required");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** No symlink following, shell expansion, config hooks or owner Python imports. */
async function read(path: string): Promise<{ text: string; fingerprint: string } | null> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) return null;
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 64 * 1024) return null;
    const buffer = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(); const current = await lstat(path);
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs) return null;
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    return { text, fingerprint: digest(JSON.stringify([opened.dev, opened.ino, opened.size, opened.mtimeMs, digest(text)])) };
  } catch (error) {
    if (error instanceof Error && "code" in error && ["ENOENT", "ELOOP"].includes(String(error.code))) return null;
    throw error;
  } finally { await handle?.close(); }
}
async function optionalRead(path: string) {
  try {
    await lstat(path);
    const value = await read(path);
    if (!value) throw denied();
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
function envKey(text: string, name: string): string {
  const lines = text.split(/\r?\n/).filter(line => new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line.trim()));
  if (lines.length !== 1) throw denied();
  let value = lines[0]!.trim().slice(lines[0]!.trim().indexOf("=") + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const quote = value[0]!; const end = value.indexOf(quote, 1);
    if (end < 1 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw denied();
    value = value.slice(1, end);
  } else value = value.replace(/\s+#.*$/, "").trim();
  if (value.includes("$") || value.includes("`") || value.includes("\\")) throw denied();
  return Key.parse(value);
}
function codexKey(text: string, now: number): string {
  const auth = z.object({ providers: z.object({ "openai-codex": z.object({
    tokens: z.object({ access_token: Key, refresh_token: Key }),
  }).passthrough().optional() }).passthrough(),
  active_provider: z.string().optional(),
  credential_pool: z.record(z.string(), z.array(z.unknown()).max(128)).optional() }).passthrough().parse(JSON.parse(text));
  const pool = auth.credential_pool?.["openai-codex"] ?? [];
  const singleton = auth.providers["openai-codex"]?.tokens.access_token;
  // The pinned CLI's `auth add` writes the default profile's credential pool.
  // Admit one explicit device login only; never reproduce account rotation.
  const entry = singleton === undefined && pool.length === 1
    ? z.object({ access_token: Key, refresh_token: Key, auth_type: z.literal("oauth"),
      source: z.literal("manual:device_code"),
      base_url: z.enum(["", endpoints["openai-codex"].url]).nullable().optional(),
    }).passthrough().parse(pool[0]) : undefined;
  const key = singleton ?? entry?.access_token;
  if (!key || (auth.active_provider && auth.active_provider !== "openai-codex")) throw denied();
  const claims = z.object({ exp: z.number().finite(), "https://api.openai.com/auth": z.object({
    chatgpt_account_id: z.string().min(1).max(256),
  }).passthrough() }).passthrough().parse(JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8")));
  // Fresh access grant only. The isolated child never receives a rotating refresh grant.
  if (claims.exp * 1000 <= now + 120_000) throw denied();
  if (pool.some(entry => !z.object({ access_token: z.literal(key) }).passthrough().safeParse(entry).success)) throw denied();
  return key;
}
export async function resolveJevHermesNativeCredential(input: {
  homePath: string; provider: JevHermesProvider; model: string; runtimeSource: AgentRuntimeSource;
  settings: ProviderSettingsSnapshot; now: () => number; signal: AbortSignal;
}): Promise<JevHermesCredentials> {
  const profile = join(input.homePath, ".hermes");
  const stats = await lstat(profile);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw denied();
  const activePath = join(profile, "active_profile");
  const active = await optionalRead(activePath);
  if (active && !["", "default"].includes(active.text.trim())) throw denied();
  const configPath = join(profile, "config.yaml");
  const secretPath = join(profile, input.provider === "openai-codex" ? "auth.json" : ".env");
  const configFile = await read(configPath); const secretFile = await read(secretPath);
  const authPath = join(profile, "auth.json");
  const authFile = input.provider === "openai-codex" ? secretFile : await optionalRead(authPath);
  if (!configFile || !secretFile) throw denied();
  const config = Config.parse(parse(configFile.text, { maxAliasCount: 0 }));
  const expected = endpoints[input.provider];
  if (config.model.provider !== input.provider || config.model.default !== input.model
    || (config.model.base_url && config.model.base_url.replace(/\/$/, "") !== expected.url)
    || (config.model.api_mode && config.model.api_mode !== expected.mode)
    || ["api_key", "key_env", "api_key_env", "openai_runtime"].some(key => config.model[key] !== undefined)) throw denied();
  const harnesses = input.settings.harnesses.filter(h => h.harness === "hermes");
  if (harnesses.length !== 1 || !(harnesses[0]!.configuredEnabled ?? harnesses[0]!.enabled)) throw denied();
  input.runtimeSource.invalidate?.();
  const runtime = await input.runtimeSource(input.signal); input.signal.throwIfAborted();
  const driver = runtime.runtime.options.find(value => value.id === "hermes");
  const providers = runtime.providers.filter(value => value.runtime === "hermes" && value.id === input.provider);
  const observed = driver?.nativeRouteObservation; const current = input.now();
  const checked = Date.parse(observed?.localObservation.checkedAt ?? "");
  const expires = Date.parse(observed?.localObservation.staleAfter ?? "");
  if (runtime.runtime.selected !== "hermes" || !runtime.messaging.configured
    || runtime.messaging.provider !== input.provider || runtime.messaging.model !== input.model
    || driver?.installState !== "installed" || !["healthy", "degraded"].includes(driver.health)
    || providers.length !== 1 || providers[0]!.authStatus.state !== "ready" || !providers[0]!.authStatus.authenticated
    || !providers[0]!.models.some(model => model.id === input.model && model.available)
    || observed?.providerId !== input.provider || observed.modelId !== input.model
    || observed.credentialKind !== (input.provider === "openai-codex" ? "provider_profile" : "api_key")
    || observed.localObservation.state !== "present_unverified" || !Number.isFinite(checked) || !Number.isFinite(expires)
    || checked > current || expires <= current || expires - checked > 5000) throw denied();
  const key = input.provider === "openai-codex" ? codexKey(secretFile.text, current) : envKey(secretFile.text, expected.key!);
  if (input.provider !== "openai-codex" && authFile) {
    const auth = z.object({ credential_pool: z.record(z.string(), z.array(z.unknown()).max(128)).optional() }).passthrough().parse(JSON.parse(authFile.text));
    if ((auth.credential_pool?.[input.provider] ?? []).some(entry =>
      !z.object({ api_key: z.literal(key) }).passthrough().safeParse(entry).success)) throw denied();
  }
  const configAfter = await read(configPath); const secretAfter = await read(secretPath);
  const activeAfter = await optionalRead(activePath);
  const authAfter = input.provider === "openai-codex" ? secretAfter : await optionalRead(authPath);
  const profileAfter = await lstat(profile);
  input.signal.throwIfAborted();
  if (configAfter?.fingerprint !== configFile.fingerprint || secretAfter?.fingerprint !== secretFile.fingerprint
    || activeAfter?.fingerprint !== active?.fingerprint) throw denied();
  if (authAfter?.fingerprint !== authFile?.fingerprint || profileAfter.ino !== stats.ino
    || profileAfter.dev !== stats.dev || profileAfter.isSymbolicLink()) throw denied();
  return { provider: input.provider, model: input.model, baseUrl: expected.url, apiMode: expected.mode,
    env: { MATRIX_JEV_PRIMARY_KEY: key } };
}
