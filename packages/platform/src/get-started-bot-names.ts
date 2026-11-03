import {
  GET_STARTED_BOT_NAME_SUGGESTION_COUNT,
  GET_STARTED_GOALS,
  GET_STARTED_PERSONALITIES,
  GetStartedBotNameSuggestionSchema,
  GetStartedBotNamesRequestSchema,
  type GetStartedBotNameSuggestion,
} from '@matrix-os/contracts';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod/v4';
import { getContainer, getRunningUserMachineByHandle, type PlatformDB } from './db.js';
import { buildPlatformVerificationToken, timingSafeTokenEquals } from './platform-token.js';
import { HANDLE_PATTERN } from './platform-route-utils.js';
import { readBoundedHostJson } from './speech/host-readiness.js';

/**
 * Spec 636, Part B: Get started bot name suggestions. A customer computer asks
 * with its machine bearer; the platform asks a small Gemini model with Matrix's
 * own key, so no model key or owner credit is involved on the computer.
 */
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';
const MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const BODY_LIMIT_BYTES = 2 * 1024;
const MODEL_TIMEOUT_MS = 8_000;
const MODEL_RESPONSE_MAX_BYTES = 32 * 1024;
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_MAX_REQUESTS = 30;
const RATE_MAX_MACHINES = 2_048;
const UNAVAILABLE = 'Name suggestions are unavailable';

const HandleSchema = z.string().regex(HANDLE_PATTERN);
const ModelReplySchema = z.object({ names: z.array(z.unknown()).max(50) });

export interface GetStartedBotNameRoutesOptions {
  platformSecret: string;
  /** The machine a handle names; null when the platform does not know it. */
  resolveMachine(handle: string): Promise<{ clerkUserId: string | null } | null>;
  geminiApiKey?: string | undefined;
  model?: string | undefined;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

class ModelReplyError extends Error {
  override readonly name = 'ModelReplyError';
}

/** Fixed labels only: the request's enums pick them, and the earlier names are already name-shaped. */
function buildPrompt(request: z.output<typeof GetStartedBotNamesRequestSchema>): string {
  const goals = GET_STARTED_GOALS.filter((goal) => request.goals.includes(goal.id)).map((goal) => goal.label);
  const personality = GET_STARTED_PERSONALITIES.find((item) => item.id === request.personality)!;
  return [
    `Suggest ${GET_STARTED_BOT_NAME_SUGGESTION_COUNT} short, memorable first names for someone's personal AI assistant, each with one fitting emoji.`,
    `They will use it for: ${goals.length > 0 ? goals.join(', ') : 'trying things out'}.`,
    `Its personality: ${personality.label}, ${personality.rule}`,
    'Each name is one or two words, letters only, at most 20 characters, easy to say, and not a real brand, product or famous person.',
    request.exclude.length > 0 ? `Do not use any of these names: ${request.exclude.join(', ')}.` : '',
    'Reply with JSON only: {"names":[{"name":"...","emoji":"..."}]}',
  ].filter(Boolean).join('\n');
}

/** Valid, new and different names from the model's reply, or an error when fewer than five survive. */
function pickNames(text: string, exclude: readonly string[]): GetStartedBotNameSuggestion[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) throw new ModelReplyError('reply is not JSON');
    throw err;
  }
  const reply = ModelReplySchema.safeParse(raw);
  if (!reply.success) throw new ModelReplyError('reply has no names');
  const seen = new Set(exclude.map((name) => name.toLowerCase()));
  const names: GetStartedBotNameSuggestion[] = [];
  for (const candidate of reply.data.names) {
    const parsed = GetStartedBotNameSuggestionSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.name.toLowerCase())) continue;
    seen.add(parsed.data.name.toLowerCase());
    names.push(parsed.data);
    if (names.length === GET_STARTED_BOT_NAME_SUGGESTION_COUNT) return names;
  }
  throw new ModelReplyError(`only ${names.length} valid names`);
}

function createRateLimiter(now: () => number) {
  const windows = new Map<string, { startedAt: number; count: number }>();
  return (handle: string): boolean => {
    const at = now();
    for (const [key, window] of windows) {
      if (at - window.startedAt >= RATE_WINDOW_MS) windows.delete(key);
    }
    const current = windows.get(handle);
    if (current) {
      if (current.count >= RATE_MAX_REQUESTS) return false;
      current.count += 1;
      return true;
    }
    if (windows.size >= RATE_MAX_MACHINES) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    windows.set(handle, { startedAt: at, count: 1 });
    return true;
  };
}

export function createGetStartedBotNameRoutes(options: GetStartedBotNameRoutesOptions): Hono {
  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredModel = options.model?.trim();
  const model = configuredModel && MODEL_PATTERN.test(configuredModel) ? configuredModel : DEFAULT_MODEL;
  const allow = createRateLimiter(options.now ?? Date.now);
  const app = new Hono();

  async function suggest(request: z.output<typeof GetStartedBotNamesRequestSchema>, apiKey: string) {
    const response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: buildPrompt(request) }] }],
        generationConfig: { responseMimeType: 'application/json', temperature: 1.1, maxOutputTokens: 400 },
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ModelReplyError(`model returned HTTP ${response.status}`);
    }
    // Read up to the cap and stop: an oversized or endless reply is never buffered.
    const body = await readBoundedHostJson(response, MODEL_RESPONSE_MAX_BYTES);
    if (body === undefined) throw new ModelReplyError('reply too large');
    const text = (body as { candidates?: { content?: { parts?: { text?: unknown }[] } }[] } | null)
      ?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof text !== 'string') throw new ModelReplyError('reply has no text');
    return pickNames(text, request.exclude);
  }

  app.post('/', bodyLimit({ maxSize: BODY_LIMIT_BYTES, onError: (c) => c.json({ error: 'Request too large' }, 413) }), async (c: Context) => {
    const handle = HandleSchema.safeParse(c.req.param('handle'));
    if (!handle.success) return c.json({ error: 'Invalid handle' }, 400);
    if (!options.platformSecret) return c.json({ error: UNAVAILABLE }, 503);
    const authorization = c.req.header('authorization');
    const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
    if (!timingSafeTokenEquals(token, buildPlatformVerificationToken(handle.data, options.platformSecret))) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    const machine = await options.resolveMachine(handle.data);
    if (!machine?.clerkUserId) return c.json({ error: 'Unknown handle' }, 404);
    if (!allow(handle.data)) return c.json({ error: 'Too many requests' }, 429);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return c.json({ error: 'Invalid request' }, 400);
    }
    const request = GetStartedBotNamesRequestSchema.safeParse(raw);
    if (!request.success) return c.json({ error: 'Invalid request' }, 400);
    if (!options.geminiApiKey) return c.json({ error: UNAVAILABLE }, 503);

    try {
      return c.json({ names: await suggest(request.data, options.geminiApiKey) });
    } catch (err) {
      // Status and reason only: the prompt, the reply and provider messages stay out of the log.
      console.error('[get-started] bot name suggestions failed:', err instanceof ModelReplyError ? err.message : err instanceof Error ? err.name : 'UnknownError');
      return c.json({ error: UNAVAILABLE }, 502);
    }
  });

  return app;
}

/** Mounts the route for customer computers; machines resolve like the Integrations routes do. */
export function registerGetStartedBotNameRoutes(app: Hono<any>, options: {
  db: PlatformDB;
  platformSecret: string;
  env: NodeJS.ProcessEnv;
}): void {
  app.route('/internal/containers/:handle/get-started/bot-names', createGetStartedBotNameRoutes({
    platformSecret: options.platformSecret,
    resolveMachine: async (handle) => (await getRunningUserMachineByHandle(options.db, handle)) ?? (await getContainer(options.db, handle)) ?? null,
    geminiApiKey: options.env.GEMINI_API_KEY,
    model: options.env.MATRIX_GET_STARTED_NAMES_MODEL,
  }));
}
