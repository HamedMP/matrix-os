import { constants } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod/v4';
import { resolveWithinHome } from '../path-security.js';

export const ManagedPiValidationLimitsSchema = z.object({
  version: z.literal(1), maxOutputTokens: z.literal(256), maxInferenceRequests: z.literal(1),
  maxRequestBytes: z.literal(131072),
  validThrough: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
}).strict();
export type ManagedPiValidationLimits = Readonly<z.infer<typeof ManagedPiValidationLimitsSchema>>;
export class ManagedPiValidationError extends Error {
  constructor() { super('Managed Chat validation unavailable'); this.name = 'ManagedPiValidationError'; }
}
export function parseManagedPiValidationLimits(value: unknown, now = Date.now()): ManagedPiValidationLimits {
  const result = ManagedPiValidationLimitsSchema.parse(value);
  const expiry = Date.parse(result.validThrough);
  if (!Number.isFinite(expiry) || new Date(expiry).toISOString() !== result.validThrough || expiry <= now || expiry - now > 3600000) throw new ManagedPiValidationError();
  return Object.freeze(result);
}
const absent = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
const MAX_PROFILE_BYTES = 4096;
/** Stable Linux directory descriptors prevent ancestor symlink swaps. Native
 * gateways without the file retain normal behavior; present files fail closed
 * on platforms without supported directory-descriptor traversal. */
export async function readManagedPiValidationLimits(homePath: string, now = Date.now()): Promise<ManagedPiValidationLimits | undefined> {
  let home: FileHandle | undefined; let system: FileHandle | undefined; let file: FileHandle | undefined;
  try {
    // Boot and ordinary Chat support relative MATRIX_HOME values. Resolve once
    // before applying the present-profile descriptor and ownership fences.
    const base = await realpath(homePath);
    if (!resolveWithinHome(base, 'system/managed-pi-validation.json')) throw new ManagedPiValidationError();
    // An absent opt-in file must not impose new ownership/mode rules on a
    // normal Gateway. Presence alone never authorizes reading its contents.
    try { await lstat(join(base, 'system/managed-pi-validation.json')); }
    catch (error: unknown) { if (absent(error)) return undefined; throw error; }
    if (process.platform !== 'linux') {
      // lstat distinguishes a dangling link from an absent entry; no symlink fallback.
      try { const parent = await lstat(join(base, 'system')); if (!parent.isDirectory() || parent.isSymbolicLink()) throw new ManagedPiValidationError(); }
      catch (error: unknown) { if (absent(error)) return undefined; throw error; }
      try { await lstat(join(base, 'system/managed-pi-validation.json')); }
      catch (error: unknown) { if (absent(error)) return undefined; throw error; }
      throw new ManagedPiValidationError();
    }
    home = await open(base, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const owner = process.getuid?.();
    const homeStat = await home.stat();
    if (owner === undefined || homeStat.uid !== owner || (homeStat.mode & 0o022) !== 0) throw new ManagedPiValidationError();
    try { system = await open(`/proc/self/fd/${home.fd}/system`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); }
    catch (error: unknown) { if (absent(error)) return undefined; throw error; }
    const parent = await system.stat();
    if (parent.uid !== owner || (parent.mode & 0o022) !== 0) throw new ManagedPiValidationError();
    try { file = await open(`/proc/self/fd/${system.fd}/managed-pi-validation.json`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error: unknown) { if (absent(error)) return undefined; throw error; }
    const before = await file.stat();
    if (!before.isFile() || before.uid !== owner || (before.mode & 0o777) !== 0o600 || before.size > MAX_PROFILE_BYTES || before.nlink !== 1) throw new ManagedPiValidationError();
    const bytes = Buffer.alloc(MAX_PROFILE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const after = await file.stat();
    if (length > MAX_PROFILE_BYTES || length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ManagedPiValidationError();
    const [namedHome, namedSystem, currentBase] = await Promise.all([lstat(base), lstat(join(base, 'system')), realpath(homePath)]);
    if (currentBase !== base || !namedHome.isDirectory() || namedHome.isSymbolicLink() || namedHome.dev !== homeStat.dev || namedHome.ino !== homeStat.ino || namedHome.uid !== owner || (namedHome.mode & 0o022) !== 0
      || !namedSystem.isDirectory() || namedSystem.isSymbolicLink() || namedSystem.dev !== parent.dev || namedSystem.ino !== parent.ino || namedSystem.uid !== owner || (namedSystem.mode & 0o022) !== 0) throw new ManagedPiValidationError();
    return parseManagedPiValidationLimits(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))), now);
  } catch (error: unknown) {
    if (!(error instanceof ManagedPiValidationError)) console.warn('[managed-pi] validation profile refused', error instanceof Error ? error.name : 'UnknownError');
    throw new ManagedPiValidationError();
  } finally {
    await file?.close(); await system?.close(); await home?.close();
  }
}

const COMMON_FIELDS = ['model', 'stream', 'messages', 'max_tokens', 'tools', 'tool_choice', 'temperature', 'top_p', 'stop'];
const ANTHROPIC_FIELDS = new Set([...COMMON_FIELDS, 'system', 'top_k', 'thinking', 'metadata', 'stop_sequences', 'service_tier']);
const OPENAI_FIELDS = new Set([...COMMON_FIELDS, 'max_completion_tokens', 'stream_options', 'response_format', 'parallel_tool_calls', 'frequency_penalty', 'presence_penalty', 'seed', 'user', 'n', 'store']);
/** Validate and serialize the provider's real request before the Relay send.
 * No worker flag can disable the trusted run snapshot or restore a larger cap. */
export function constrainManagedPiValidationBody(action: string, raw: string, limits: ManagedPiValidationLimits): string {
  if (Buffer.byteLength(raw, 'utf8') > limits.maxRequestBytes) throw new ManagedPiValidationError();
  const body: unknown = JSON.parse(raw);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ManagedPiValidationError();
  const values = body as Record<string, unknown>;
  const fields = action === 'inference.messages' ? ANTHROPIC_FIELDS : action === 'inference.chat_completions' ? OPENAI_FIELDS : undefined;
  if (!fields || Object.keys(values).some(key => !fields.has(key))) throw new ManagedPiValidationError();
  if (values.thinking !== undefined && (!values.thinking || typeof values.thinking !== 'object' || Array.isArray(values.thinking)
    || Object.keys(values.thinking).length !== 1 || (values.thinking as Record<string, unknown>).type !== 'disabled')) throw new ManagedPiValidationError();
  if (values.store !== undefined && values.store !== false) throw new ManagedPiValidationError();
  const outputKeys = ['max_tokens', 'max_completion_tokens'].filter(key => Object.hasOwn(values, key));
  if (outputKeys.length > 1 || (values.n !== undefined && values.n !== 1)) throw new ManagedPiValidationError();
  const key = outputKeys[0] ?? 'max_tokens'; const output = values[key];
  if (output !== undefined && (typeof output !== 'number' || !Number.isSafeInteger(output) || output < 1)) throw new ManagedPiValidationError();
  // Scan only model inputs, not JSON tool schemas whose property names are data.
  const pending: unknown[] = [values.messages, values.system];
  let visited = 0;
  while (pending.length) {
    if (++visited > 16384) throw new ManagedPiValidationError();
    const part = pending.pop();
    if (!part || typeof part !== 'object') continue;
    if (Array.isArray(part)) { pending.push(...part); continue; }
    const block = part as Record<string, unknown>;
    if (typeof block.type === 'string' && !['text', 'tool_use', 'tool_result', 'thinking', 'redacted_thinking', 'function'].includes(block.type)
      || ['image_url', 'input_audio', 'audio', 'video', 'source'].some(field => Object.hasOwn(block, field))) throw new ManagedPiValidationError();
    for (const [field, value] of Object.entries(block)) {
      if (block.type === 'tool_use' && field === 'input') continue; // Tool arguments are data, not media content blocks.
      pending.push(value);
    }
  }
  values[key] = Math.min((output as number | undefined) ?? limits.maxOutputTokens, limits.maxOutputTokens);
  const serialized = JSON.stringify(values);
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxRequestBytes) throw new ManagedPiValidationError();
  return serialized;
}
