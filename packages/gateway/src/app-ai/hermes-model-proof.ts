import { z } from 'zod/v4';
import type { HermesAppProvider } from './hermes-credential-proof.js';
import { boundedBody, discardFailureBody } from './hermes-http-body.js';

const ModelId = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/);
const denied = () => new Error('App AI model unavailable');
/** Resolve only fixed provider metadata endpoints. No cache or inferred alias prefixes. */
export async function proveHermesModel(options: {
  provider: HermesAppProvider; model: string; key: string; signal: AbortSignal; fetchImpl?: typeof fetch;
}): Promise<{ model: string; responseModels: string[] }> {
  const requested = ModelId.parse(options.model);
  // The native ChatGPT catalog does not attest alias-to-snapshot identity.
  // Deny before inference; the separately scoped paired adapter is independent.
  if (options.provider === 'openai-codex') throw denied();
  const headers = new Headers({ accept: 'application/json' });
  let url: string;
  if (options.provider === 'anthropic') {
    headers.set('x-api-key', options.key); headers.set('anthropic-version', '2023-06-01');
    url = `https://api.anthropic.com/v1/models/${encodeURIComponent(requested)}`;
  } else {
    headers.set('authorization', `Bearer ${options.key}`);
    if (options.provider === 'openrouter') {
      const parts = requested.split('/');
      if (parts.length !== 2 || parts[0] === 'openrouter' || parts.some(part => !part)) throw denied();
      url = `https://openrouter.ai/api/v1/model/${parts.map(encodeURIComponent).join('/')}`;
    } else url = `https://api.openai.com/v1/models/${encodeURIComponent(requested)}`;
  }
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(10000)]);
  signal.throwIfAborted();
  const response = await (options.fetchImpl ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal });
  if (!response.ok) { await discardFailureBody(response); throw denied(); }
  const payload = JSON.parse(await boundedBody(response, signal, 65536, 1024));
  if (options.provider === 'anthropic') {
    // Anthropic explicitly documents this endpoint as an alias resolver.
    const metadata = z.object({ type: z.literal('model'), id: ModelId.regex(/^claude-/), lifecycle: z.enum(['active', 'deprecated', 'retired']).optional() }).parse(payload);
    if (metadata.lifecycle === 'retired') throw denied();
    return { model: metadata.id, responseModels: [metadata.id] };
  }
  if (options.provider === 'openrouter') {
    // Only a permanent slug attested as the executable API ID can be pinned.
    const metadata = z.object({ data: z.object({ id: ModelId, canonical_slug: ModelId }) }).parse(payload).data;
    const author = requested.split('/')[0];
    const variant = requested.split(':').slice(1).join(':');
    if (metadata.id !== metadata.canonical_slug
      || [metadata.id, metadata.canonical_slug].some(id => id.split('/').length !== 2 || id.split('/')[0] !== author)
      || metadata.id.split(':').slice(1).join(':') !== variant) throw denied();
    return { model: metadata.id, responseModels: [metadata.id] };
  }
  // OpenAI model metadata does not promise alias resolution. Only a live, dated
  // snapshot can be pinned; an unchanged dateless alias fails before inference.
  const metadata = z.object({ object: z.literal('model'), id: ModelId, owned_by: z.enum(['openai', 'system']), shutdown_date: z.iso.date().nullable().optional() }).parse(payload);
  if (!/^[A-Za-z0-9._-]+-\d{4}-\d{2}-\d{2}$/.test(metadata.id)
    || metadata.shutdown_date && Date.parse(metadata.shutdown_date) <= Date.now()) throw denied();
  return { model: metadata.id, responseModels: [metadata.id] };
}
