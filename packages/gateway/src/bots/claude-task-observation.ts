import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AiProviderSnapshotV3 } from '@matrix-os/contracts';
import type { ClaudeTaskObservation } from './provider-connections.js';
import { claudeBotEnvironment } from './claude-task-executor.js';
const run = promisify(execFile);
export const claudeBotCommand = () => join(process.env.MATRIX_NODE_PREFIX ?? '/opt/matrix/runtime/node', 'bin/claude');
/** A documented flag is still gated by the actual installed native protocol. */
export function qualifiesClaudeBotRuntime(version: string, help: string): boolean {
  const parsed = /^2\.1\.(\d+)\b/.exec(version.trim());
  return Boolean(parsed && Number(parsed[1]) >= 259 && ['--restricted', '--tools', '--strict-mcp-config', '--setting-sources', '--output-format', '--permission-prompts']
    .every(flag => help.includes(flag)));
}
export function createClaudeTaskObserver(input: { homePath: string; providers: { getSnapshot(): Promise<AiProviderSnapshotV3> } }) {
  return async (): Promise<ClaudeTaskObservation> => {
    const env = claudeBotEnvironment(input.homePath); const command = claudeBotCommand();
    try {
      const [version, help] = await Promise.all([run(command, ['--version'], { env, timeout: 5000, maxBuffer: 64 * 1024 }),
        run(command, ['--help'], { env, timeout: 5000, maxBuffer: 64 * 1024 })]);
      if (!qualifiesClaudeBotRuntime(version.stdout, help.stdout)) return { available: false, reason: 'unsupported_runtime' };
      const status = await run(command, ['auth', 'status', '--json'], { env, timeout: 5000, maxBuffer: 16 * 1024 });
      const authentication = JSON.parse(status.stdout);
      if (authentication.loggedIn !== true || authentication.authMethod !== 'claude.ai') return { available: false, reason: 'authentication_required' };
      // Stable account identity rather than a rotating bearer. No subscription token is read/copied.
      const profile = await open(join(input.homePath, '.claude.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let accountUuid: unknown;
      try {
        const metadata = await profile.stat();
        if (!metadata.isFile() || metadata.size > 1024 * 1024) throw new Error('Native profile unavailable');
        const buffer = Buffer.alloc(1024 * 1024 + 1); const { bytesRead } = await profile.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 1024 * 1024) throw new Error('Native profile too large');
        accountUuid = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')).oauthAccount?.accountUuid;
      } finally { await profile.close(); }
      if (typeof accountUuid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(accountUuid)) return { available: false, reason: 'authentication_required' };
      const snapshot = await input.providers.getSnapshot();
      const source = snapshot.accessSources.find(entry => entry.id === 'owner_anthropic_profile' && entry.state === 'ready'
        && (entry.staleAfter === null || Date.parse(entry.staleAfter) > Date.now()));
      const models = source ? snapshot.models.filter(model => model.vendor === 'anthropic' && model.status !== 'retired' && model.status !== 'unavailable'
        && source.eligibleModelIds.includes(model.id) && model.eligibleAccessSourceIds.includes(source.id))
        .slice(0, 128).map(model => ({ id: model.id, displayName: model.displayName })) : [];
      if (!models.length) return { available: false, reason: 'authentication_required' };
      return { available: true, fingerprint: createHash('sha256').update(accountUuid).digest('hex'), models };
    } catch (error) {
      console.warn('[bot-native] Observation unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return { available: false, reason: 'unsupported_runtime' };
    }
  };
}
