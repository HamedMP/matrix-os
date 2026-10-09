import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod/v4';
import { isLocallyObservedNativeHarnessRoute, type AiProviderSnapshotV3, type ProviderAccessSource, type ProviderHarnessInstance } from '@matrix-os/contracts';
import { hermesNativeModelId, projectHermesNativeCatalog } from '../ai-providers/hermes-native-catalog.js';
import type { AgentRuntimeSource } from '../agent-config/service.js';
import { proveHermesModel } from './hermes-model-proof.js';

export const HERMES_APP_ENDPOINTS = {
  anthropic: { url: 'https://api.anthropic.com/v1/messages', base: 'https://api.anthropic.com', key: 'ANTHROPIC_API_KEY', mode: 'anthropic_messages' },
  'openai-api': { url: 'https://api.openai.com/v1/responses', base: 'https://api.openai.com/v1', key: 'OPENAI_API_KEY', mode: 'codex_responses' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions', base: 'https://openrouter.ai/api/v1', key: 'OPENROUTER_API_KEY', mode: 'chat_completions' },
  'openai-codex': { url: 'https://chatgpt.com/backend-api/codex/responses', base: 'https://chatgpt.com/backend-api/codex', key: null, mode: 'codex_responses' },
} as const;
export type HermesAppProvider = keyof typeof HERMES_APP_ENDPOINTS;
export interface HermesAppSelection {
  harness: ProviderHarnessInstance; source: ProviderAccessSource; canonical: AiProviderSnapshotV3; signal: AbortSignal;
}
const denied = () => new Error('App AI native profile unavailable');
const Key = z.string().min(1).max(8192).regex(/^[\x21-\x7e]+$/);
const Config = z.object({ model: z.object({ provider: z.string(), default: z.string(), base_url: z.string().optional(), api_mode: z.string().optional() }).passthrough() }).passthrough();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function read(path: string): Promise<{ text: string; fingerprint: string } | null> {
  let handle;
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size > 65536) throw denied();
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size > 65536) throw denied();
    const buffer = Buffer.alloc(opened.size + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat(); const current = await lstat(path);
    if (bytesRead !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs) throw denied();
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    return { text, fingerprint: digest(JSON.stringify([opened.dev, opened.ino, opened.size, opened.mtimeMs, digest(text)])) };
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}
function envKey(text: string, name: string): string {
  const lines = text.split(/\r?\n/).filter(line => new RegExp(`^(?:export\\s+)?${name}\\s*=`).test(line.trim()));
  if (lines.length !== 1) throw denied();
  let value = lines[0]!.trim().slice(lines[0]!.trim().indexOf('=') + 1).trim();
  if (value.startsWith('"') || value.startsWith("'")) {
    const end = value.indexOf(value[0]!, 1);
    if (end < 1 || !/^\s*(?:#.*)?$/.test(value.slice(end + 1))) throw denied();
    value = value.slice(1, end);
  } else value = value.replace(/\s+#.*$/, '').trim();
  if (/[\$`\\]/.test(value)) throw denied();
  return Key.parse(value);
}
function credential(authText: string | undefined, envText: string | undefined, provider: HermesAppProvider, now: number) {
  const auth = authText === undefined ? {} : z.object({ credential_pool: z.record(z.string(), z.array(z.unknown()).max(128)).optional(), active_provider: z.string().optional(), providers: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(JSON.parse(authText));
  const pool = auth.credential_pool?.[provider] ?? [];
  if (provider !== 'openai-codex' && pool.length !== 0) throw denied();
  if (provider !== 'openai-codex') return { key: envKey(envText ?? '', HERMES_APP_ENDPOINTS[provider].key!), accountId: undefined };
  if (auth.active_provider && auth.active_provider !== provider) throw denied();
  const singleton = auth.providers?.[provider];
  if (singleton !== undefined && pool.length !== 0 || singleton === undefined && pool.length !== 1) throw denied();
  const key = singleton !== undefined ? z.object({ tokens: z.object({ access_token: Key }) }).passthrough().parse(singleton).tokens.access_token
    : z.object({ access_token: Key, auth_type: z.literal('oauth'), source: z.literal('manual:device_code'),
      base_url: z.enum(['', 'https://chatgpt.com/backend-api/codex']).nullable().optional() }).passthrough().parse(pool[0]).access_token;
  const parts = key.split('.');
  if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part) || Buffer.from(part,'base64url').toString('base64url')!==part)) throw denied();
  z.object({ alg:z.enum(['RS256','ES256','ES384','ES512','PS256','EdDSA']) }).passthrough().parse(JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')));
  const claims = z.object({ exp: z.number().finite(), 'https://api.openai.com/auth': z.object({ chatgpt_account_id: z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/) }).passthrough() }).passthrough().parse(JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')));
  if (!Number.isFinite(claims.exp * 1000) || claims.exp * 1000 <= now + 120000) throw denied();
  return { key, accountId: claims['https://api.openai.com/auth'].chatgpt_account_id };
}
function observed(input: HermesAppSelection, now: number): { provider: HermesAppProvider; model: string } {
  const { harness, source, canonical } = input;
  const provider = harness.route.providerId as HermesAppProvider;
  if (!Object.hasOwn(HERMES_APP_ENDPOINTS, provider) || harness.harness !== 'hermes' || !(harness.configuredEnabled ?? harness.enabled) || harness.installState !== 'installed'
    || harness.selectedAccountId !== null || source.kind !== 'harness_profile' || source.harness !== 'hermes' || source.accountId !== null
    || source.id !== harness.accessSourceId || source.providerId !== provider || !isLocallyObservedNativeHarnessRoute(harness, source, new Date(now))) throw denied();
  const model = hermesNativeModelId(harness, source); if (!model) throw denied();
  const profiles = canonical.nativeHarnessCatalog?.profiles.filter(entry => entry.harness === 'hermes' && entry.providerId === provider) ?? [];
  const profile = profiles.length === 1 ? profiles[0] : undefined;
  const checked = Date.parse(profile?.localObservation.checkedAt ?? ''); const expires = Date.parse(profile?.localObservation.staleAfter ?? '');
  if (!profile || !profile.models.some(entry => entry.id === harness.route.modelId && entry.enabled) || profile.localObservation.state !== 'present_unverified'
    || !Number.isFinite(checked) || !Number.isFinite(expires) || checked > now || expires <= now || expires <= checked || expires - checked > 5000) throw denied();
  return { provider, model };
}
/** App authority is its exact native source, independent of Matrix Inbox defaults. */
export async function proveHermesAppCredential(options: HermesAppSelection & { homePath: string; runtimeSource: AgentRuntimeSource; now?: () => number; fetchImpl?: typeof fetch }) {
  const now = options.now ?? Date.now; const { provider, model } = observed(options, now());
  const directory = join(options.homePath, '.hermes'); const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw denied();
  const paths = ['config.yaml', '.env', 'auth.json', 'active_profile'].map(name => join(directory, name));
  async function files() {
    const values = await Promise.all(paths.map(read)); const current = await lstat(directory);
    if (!current.isDirectory() || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw denied();
    return values;
  }
  const before = await files();
  if (!before[0] || before[3] && !['', 'default'].includes(before[3].text.trim())) throw denied();
  const config = Config.parse(parse(before[0].text, { maxAliasCount: 0 })); const endpoint = HERMES_APP_ENDPOINTS[provider];
  // The default native provider identifies the credential/transport configuration.
  // Its model default is independent: apps may choose any exact eligible model.
  if (config.model.provider !== provider || config.model.base_url && config.model.base_url.replace(/\/+$/, '') !== endpoint.base
    || config.model.api_mode && config.model.api_mode !== endpoint.mode
    || ['api_key', 'key_env', 'api_key_env', 'openai_runtime'].some(key => config.model[key] !== undefined)) throw denied();
  if (before[1] && /^\s*(?:export\s+)?(?:OPENAI_BASE_URL|OPENAI_API_BASE|ANTHROPIC_BASE_URL|OPENROUTER_BASE_URL|HERMES_CODEX_BASE_URL)\s*=/m.test(before[1].text.trim())) throw denied();
  const secret = credential(before[2]?.text, before[1]?.text, provider, now());
  const unchanged = async () => {
    options.signal.throwIfAborted(); const after = await files();
    if (after.some((entry, index) => entry?.fingerprint !== before[index]?.fingerprint)) throw denied();
    credential(after[2]?.text, after[1]?.text, provider, now());
  };
  const live = async () => {
    options.signal.throwIfAborted(); options.runtimeSource.invalidate?.();
    const runtime = await options.runtimeSource(options.signal); options.signal.throwIfAborted();
    const current = projectHermesNativeCatalog(runtime, new Date(now()));
    const profile = current.profiles.find(entry => entry.harness === 'hermes' && entry.providerId === provider);
    observed({ ...options, source: { ...options.source, localObservation: profile?.localObservation }, canonical: { ...options.canonical, nativeHarnessCatalog: current } }, now());
    await unchanged();
  };
  await live();
  const resolved = await proveHermesModel({ provider, model, key: secret.key, signal: options.signal, fetchImpl: options.fetchImpl });
  // Metadata may outlive the five-second observation or a credential mutation.
  await live();
  return { provider, ...resolved, ...secret, unchanged, live };
}
