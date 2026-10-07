import { lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import type { AiProviderReadiness } from '@matrix-os/contracts';
import { z } from 'zod/v4';
import { readBoundedJsonFileWithIdentity } from '../bounded-json-file.js';
const Auth = z.object({ OPENAI_API_KEY: z.string().min(8).max(4096), tokens: z.null().optional(), auth_mode: z.literal('apikey').optional() });
export function createCodexNativeKeyReadinessReader(options: {
  homePath: string;
  fetchFn?: typeof fetch;
  now?: () => Date;
}): () => Promise<AiProviderReadiness | null> {
  const path = join(resolve(options.homePath), '.codex', 'auth.json');
  const now = options.now ?? (() => new Date());
  let cached: {
    identity: string;
    result: AiProviderReadiness;
    expires: number;
  } | undefined;
  let inFlight: Promise<AiProviderReadiness | null> | undefined;
  async function read(): Promise<{
    key: string;
    identity: string;
  } | null> {
    if (process.env.CODEX_HOME && resolve(process.env.CODEX_HOME) !== resolve(options.homePath, '.codex'))
      return null;
    try {
      const directory = await lstat(join(resolve(options.homePath), '.codex'));
      if (!directory.isDirectory() || directory.isSymbolicLink())
        return null;
      const document = await readBoundedJsonFileWithIdentity(path, 65536);
      if (!document)
        return null;
      const parsed = Auth.safeParse(document.value);
      return parsed.success ? { key: parsed.data.OPENAI_API_KEY, identity: createHash('sha256').update(parsed.data.OPENAI_API_KEY).digest('hex') } : null;
    }
    catch (error) {
      if (!(error instanceof SyntaxError) && (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT'))
        console.warn('[provider-workflow] Native key unavailable:', error instanceof Error ? error.name : 'UnknownError');
      return null;
    }
  }
  return () => {
    if (inFlight)
      return inFlight;
    inFlight = (async () => {
      const initial = await read();
      if (!initial) {
        cached = undefined;
        return null;
      }
      if (cached?.identity === initial.identity && cached.expires > now().getTime())
        return { ...cached.result };
      const checked = now();
      let result: AiProviderReadiness = { state: 'unknown', checkedAt: checked.toISOString(), staleAfter: null, action: 'retry', safeReason: 'unknown' };
      try {
        const response = await (options.fetchFn ?? fetch)('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${initial.key}` }, redirect: 'error', signal: AbortSignal.timeout(2000) });
        await response.body?.cancel();
        if ((await read())?.identity !== initial.identity)
          return null;
        if (response.status === 200)
          result = { state: 'ready', checkedAt: checked.toISOString(), staleAfter: new Date(checked.getTime() + 30000).toISOString(), action: 'none', safeReason: null };
        else if (response.status === 401 || response.status === 403)
          result = { state: 'invalid', checkedAt: checked.toISOString(), staleAfter: new Date(checked.getTime() + 5000).toISOString(), action: 'enter_api_key', safeReason: 'auth' };
      }
      catch (error) {
        console.warn('[provider-workflow] Native key verification unavailable:', error instanceof Error ? error.name : 'UnknownError');
      }
      if ((await read())?.identity !== initial.identity)
        return null;
      cached = { identity: initial.identity, result, expires: now().getTime() + (result.state === 'ready' ? 30000 : 5000) };
      return { ...result };
    })().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
