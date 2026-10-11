import { mkdtemp, mkdir, rm, writeFile, symlink, chmod } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readManagedPiValidationLimits, parseManagedPiValidationLimits, constrainManagedPiValidationBody } from '../../../packages/gateway/src/chat/managed-pi-validation-limits.js';
const now = Date.parse('2026-10-09T12:00:00.000Z');
const profile = { version: 1, maxOutputTokens: 256, maxInferenceRequests: 1, maxRequestBytes: 131072, validThrough: '2026-10-09T12:30:00.000Z' } as const;
const homes: string[] = [];
afterEach(async () => { for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function home() { const h = await mkdtemp(join(tmpdir(), 'matrix-validation-test-')); homes.push(h); await mkdir(join(h, 'system')); return h; }
describe('owner-authored finite managed Pi validation profile', () => {
  it('accepts only the fixed bounded profile and returns an immutable snapshot', () => {
    const result = parseManagedPiValidationLimits(profile, now); expect(result).toEqual(profile); expect(Object.isFrozen(result)).toBe(true);
  });
  it.each([{ version: 2 }, { maxOutputTokens: 32 }, { maxOutputTokens: 257 }, { maxInferenceRequests: 2 }, { maxRequestBytes: 131073 }, { extra: true }, { validThrough: '2026-10-09T12:00:00.000Z' }, { validThrough: '2026-10-09T13:00:00.001Z' }, { validThrough: '2026-10-09T12:30:00+00:00' }])('rejects malformed, expired or widened profile %j', patch => { expect(() => parseManagedPiValidationLimits({ ...profile, ...patch }, now)).toThrow(); });
  it('preserves normal absence even when activation ownership/mode checks would fail', async () => { const h = await home(); await chmod(h, 0o777); expect(await readManagedPiValidationLimits(h, now)).toBeUndefined(); });
  it('accepts resumed OpenAI function calls and Anthropic tool arguments as data', () => { expect(() => constrainManagedPiValidationBody('inference.chat_completions', JSON.stringify({ max_completion_tokens: 256, messages: [{ role: 'assistant', tool_calls: [{ type: 'function', function: { name: 'echo', arguments: '{}' } }] }] }), profile)).not.toThrow(); expect(() => constrainManagedPiValidationBody('inference.messages', JSON.stringify({ max_tokens: 256, messages: [{ content: [{ type: 'tool_use', input: { type: 'image', source: 'argument-data' } }] }] }), profile)).not.toThrow(); });
  it('preserves an existing relative MATRIX_HOME with no opt-in file', async () => { const h = await home(); expect(await readManagedPiValidationLimits(relative(process.cwd(), h), now)).toBeUndefined(); });
  it('treats only absent fixed profile as normal', async () => { expect(await readManagedPiValidationLimits(await home(), now)).toBeUndefined(); });
  it.each(['malformed', 'oversized', 'symlink', 'writable', 'public_readable'])('fails closed for an existing %s profile', async kind => {
    const h = await home(); const p = join(h, 'system/managed-pi-validation.json');
    if (kind === 'symlink') { await writeFile(join(h, 'other'), JSON.stringify(profile)); await symlink(join(h, 'other'), p); }
    else { await writeFile(p, kind === 'malformed' ? '{' : kind === 'oversized' ? 'x'.repeat(4097) : JSON.stringify(profile), { mode: 0o600 }); if (kind === 'writable') await chmod(p, 0o666); if (kind === 'public_readable') await chmod(p, 0o644); }
    await expect(readManagedPiValidationLimits(h, now)).rejects.toThrow();
  });
  it.skipIf(process.platform !== 'linux')('reads a regular owner file through anchored directory descriptors', async () => {
    const h = await home(); await writeFile(join(h, 'system/managed-pi-validation.json'), JSON.stringify(profile), { mode: 0o600 });
    expect(await readManagedPiValidationLimits(h, now)).toEqual(profile);
  });
  it('rejects a symlinked system ancestor instead of following it', async () => {
    const h = await home(); await rm(join(h, 'system'), { recursive: true }); await mkdir(join(h, 'other')); await symlink(join(h, 'other'), join(h, 'system')); await writeFile(join(h, 'other/managed-pi-validation.json'), JSON.stringify(profile));
    await expect(readManagedPiValidationLimits(h, now)).rejects.toThrow();
  });
});
describe('trusted validation payload clamp', () => {
  it.each(['inference.messages', 'inference.chat_completions'] as const)('clamps actual %s output before Relay transport, preserving stream/tools', action => {
    const field = action === 'inference.messages' ? 'max_tokens' : 'max_completion_tokens';
    const body = { model: 'test', stream: true, [field]: 8192, messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'safe' }] };
    const result = JSON.parse(constrainManagedPiValidationBody(action, JSON.stringify(body), profile));
    expect(result).toEqual({ ...body, [field]: 256 });
  });
  it('accepts actual SDK OpenAI store=false and rejects store=true', () => { expect(JSON.parse(constrainManagedPiValidationBody('inference.chat_completions', JSON.stringify({ max_completion_tokens: 8192, store: false, stream_options: { include_usage: true }, messages: [] }), profile))).toMatchObject({ max_completion_tokens: 256, store: false }); expect(() => constrainManagedPiValidationBody('inference.chat_completions', JSON.stringify({ max_completion_tokens: 256, store: true }), profile)).toThrow(); });
  it('bounds traversal nodes as well as raw bytes', () => { expect(() => constrainManagedPiValidationBody('inference.messages', JSON.stringify({ max_tokens: 256, messages: Array.from({length: 16385}, () => 0) }), profile)).toThrow(); });
  it('retains a smaller positive output request', () => { expect(JSON.parse(constrainManagedPiValidationBody('inference.messages', JSON.stringify({ max_tokens: 32, messages: [] }), profile)).max_tokens).toBe(32); });
  it.each([{ max_tokens: 0 }, { max_tokens: '256' }, { max_tokens: 1.5 }, { max_tokens: 256, thinking: { type: 'enabled', budget_tokens: 1024 } }, { max_tokens: 256, thinking: { type: 'adaptive' } }, { max_tokens: 256, max_completion_tokens: 256 }, { max_tokens: 256, max_output_tokens: 256 }, { max_tokens: 256, n: 2 }, { max_tokens: 256, messages: [{ content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid' } }] }] }, { max_tokens: 256, messages: [{ content: [{ type: 'image_url', image_url: { url: 'data:image/png;abc' } }] }] }])('rejects invalid or conflicting fields/vision %j', body => { expect(() => constrainManagedPiValidationBody('inference.messages', JSON.stringify(body), profile)).toThrow(); });
  it('rejects raw request bytes before parsing', () => { expect(() => constrainManagedPiValidationBody('inference.messages', ' '.repeat(131073), profile)).toThrow(); });
});
