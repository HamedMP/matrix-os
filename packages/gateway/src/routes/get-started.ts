import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  GetStartedBotNamesRequestSchema,
  GetStartedStateSchema,
  GetStartedUpdateSchema,
  type GetStartedBotNamesRequest,
  type GetStartedBotNamesResponse,
  type GetStartedAnswers,
  type GetStartedResponse,
  type GetStartedSavedBot,
  type GetStartedState,
  type GetStartedUpdate,
} from "@matrix-os/contracts";
import { withPinnedSystemDir, type PinnedSystemDir } from "../get-started/owner-system-dir.js";
import { OwnerFileMutationBusyError, withOwnerFileMutation } from "../owner-file-mutations.js";
import { applyGetStartedPersonality } from "../get-started/personality.js";
import { GET_STARTED_MATRIX_BOT_RECIPE_ID } from "../get-started/bots.js";

// Spec 635: seeded new homes and eligible zero-agent owners share one durable
// setup record. Both files live in the owner's `system` directory, through its pin.
const STATE_FILE = "get-started.json";
const ONBOARDING_COMPLETE_FILE = "onboarding-complete.json";
const PUT_BODY_LIMIT = 8 * 1024;
const BOT_NAMES_BODY_LIMIT = 2 * 1024;
const STATE_FILE_MAX_BYTES = 16 * 1024;

const LOAD_ERROR = "Unable to load your setup";
const SAVE_ERROR = "Unable to save your setup";
const BOTS_ERROR = "Bots are unavailable on this computer";
const BOT_NAMES_ERROR = "Name suggestions are unavailable";

// A finished setup retries its saved bots when read, at most this often per owner.
const BOT_RECONCILE_COOLDOWN_MS = 10 * 60 * 1000;
const BOT_RECONCILE_MAX_OWNERS = 256;

export interface GetStartedRoutesOptions {
  homePath: string;
  /** Kill switch (`MATRIX_GET_STARTED_ENABLED`). When false every home reads as not eligible. */
  enabled: boolean;
  now?: () => Date;
  /** The authenticated owner, for creating their Matrix Bot. */
  getOwnerId?: (c: Context) => string | null;
  /** Primary computer owner with no active Matrix agents; inventory errors must propagate. */
  canEnroll?: (ownerId: string) => Promise<boolean>;
  /** Creates (or replays) a bot from a recipe. Best effort: setup never fails on it. */
  ensureBot?: (ownerId: string, recipeId: string, name?: string) => Promise<void>;
  /** What a saved bot choice made: the bot it created, or "pending" while its creation never finished. */
  botStatus?: (ownerId: string, recipeId: string) => Promise<GetStartedSavedBot>;
  /** Spec 636: asks the platform for bot name suggestions; absent without a platform link. */
  suggestBotNames?: (request: GetStartedBotNamesRequest, signal: AbortSignal) => Promise<GetStartedBotNamesResponse>;
}

class GetStartedStateCorruptError extends Error {
  constructor(reason: string) {
    super(`get-started state is unreadable: ${reason}`);
  }
}

type Transition =
  | { kind: "write"; state: GetStartedState }
  | { kind: "unchanged"; state: GetStartedState }
  | { kind: "conflict" };

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : "UnknownError";
}

async function readState(dir: PinnedSystemDir): Promise<GetStartedState | null> {
  const text = await dir.readFile(STATE_FILE, STATE_FILE_MAX_BYTES);
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) throw new GetStartedStateCorruptError("invalid JSON");
    throw err;
  }
  const parsed = GetStartedStateSchema.safeParse(raw);
  if (!parsed.success) throw new GetStartedStateCorruptError("unexpected shape");
  return parsed.data;
}

export function transitionGetStarted(state: GetStartedState, update: GetStartedUpdate, now: Date): Transition {
  const at = now.toISOString();
  const open = state.status === "pending" || state.status === "in_progress";
  switch (update.type) {
    case "draft":
      return open
        ? { kind: "write", state: { version: 1, status: "in_progress", updatedAt: at, draft: update.draft } }
        : { kind: "conflict" };
    case "complete":
      if (state.status === "completed") return { kind: "unchanged", state };
      return open
        ? { kind: "write", state: { version: 1, status: "completed", completedAt: at, answers: update.answers } }
        : { kind: "conflict" };
    case "skip":
      if (state.status === "skipped") return { kind: "unchanged", state };
      return open
        ? { kind: "write", state: { version: 1, status: "skipped", skippedAt: at } }
        : { kind: "conflict" };
  }
}

function toResponse(state: GetStartedState): GetStartedResponse {
  const { version: _version, ...rest } = state;
  return rest;
}

function isTerminal(state: GetStartedState): boolean {
  return state.status === "completed" || state.status === "skipped";
}

/** Marks the legacy first-run flag too, without ever replacing an existing one. */
async function ensureOnboardingMarker(dir: PinnedSystemDir, at: string): Promise<void> {
  await dir.createExclusive(ONBOARDING_COMPLETE_FILE, `${JSON.stringify({ completedAt: at, source: "get-started" })}\n`);
}

export function createGetStartedRoutes(opts: GetStartedRoutesOptions) {
  const { homePath, enabled } = opts;
  const now = opts.now ?? (() => new Date());
  const app = new Hono();

  /** The named Matrix Bot first, then the ready-made bots the owner added. */
  function savedBotJobs(answers: GetStartedAnswers): { recipeId: string; name: string | undefined }[] {
    return [
      ...(answers.bot ? [{ recipeId: GET_STARTED_MATRIX_BOT_RECIPE_ID, name: answers.bot.name }] : []),
      ...(answers.bots ?? []).map((recipeId) => ({ recipeId, name: undefined })),
    ];
  }

  /**
   * Creates the owner's saved bot choices that were never created. The saved answers are the
   * durable intent and the fixed request IDs keep this idempotent: a retry never duplicates a
   * bot and never brings back one the owner deleted. A bot already created is not requested
   * again (that would conflict once its recipe version moves on). Each failure is logged and
   * reported, never thrown.
   */
  async function ensureSavedBots(ownerId: string, answers: GetStartedAnswers): Promise<Record<string, "ready" | "failed">> {
    const results: Record<string, "ready" | "failed"> = {};
    if (!opts.ensureBot) return results;
    for (const job of savedBotJobs(answers)) {
      try {
        if (opts.botStatus && (await opts.botStatus(ownerId, job.recipeId)).status === "created") {
          results[job.recipeId] = "ready";
          continue;
        }
        await opts.ensureBot(ownerId, job.recipeId, job.name);
        results[job.recipeId] = "ready";
      } catch (botError: unknown) {
        console.warn(`[get-started] Bot ${job.recipeId} unavailable:`, errorName(botError));
        results[job.recipeId] = "failed";
      }
    }
    return results;
  }

  // Owner -> when their saved bots were last ensured; bounded, oldest evicted first.
  const lastEnsured = new Map<string, number>();
  function markEnsured(ownerId: string): void {
    lastEnsured.delete(ownerId);
    lastEnsured.set(ownerId, now().getTime());
    while (lastEnsured.size > BOT_RECONCILE_MAX_OWNERS) {
      const oldest = lastEnsured.keys().next().value;
      if (oldest === undefined) break;
      lastEnsured.delete(oldest);
    }
  }

  /** Spec 635: a bot whose creation failed is retried when the finished setup is next read. */
  function reconcileSavedBots(c: Context, state: GetStartedState): void {
    if (state.status !== "completed" || savedBotJobs(state.answers).length === 0 || !opts.ensureBot) return;
    const ownerId = opts.getOwnerId?.(c) ?? null;
    if (!ownerId) return;
    const last = lastEnsured.get(ownerId);
    if (last !== undefined && now().getTime() - last < BOT_RECONCILE_COOLDOWN_MS) return;
    markEnsured(ownerId);
    void ensureSavedBots(ownerId, state.answers);
  }

  app.get("/", bodyLimit({ maxSize: PUT_BODY_LIMIT }), async (c) => {
    if (!enabled) return c.json({ status: "not_eligible" } satisfies GetStartedResponse);
    try {
      const state = await withOwnerFileMutation(homePath, () => withPinnedSystemDir(homePath, async (dir) => {
        const saved = await readState(dir);
        // Saved progress and terminal receipts always win, including after an agent is removed.
        if (saved) return saved;
        const ownerId = opts.getOwnerId?.(c) ?? null;
        if (!opts.canEnroll || !ownerId) return null;
        const marker = await dir.readFile(ONBOARDING_COMPLETE_FILE, STATE_FILE_MAX_BYTES);
        const receipt: unknown = marker === null ? null : JSON.parse(marker);
        if (receipt !== null && typeof receipt === "object" && "source" in receipt && receipt.source === "get-started") return null;
        if (!await opts.canEnroll(ownerId)) return null;
        // Exclusive atomic publication also protects against another gateway's seed/write.
        await dir.createExclusive(STATE_FILE, `${JSON.stringify({ version: 1, status: "pending" })}\n`);
        return readState(dir);
      }));
      if (state) reconcileSavedBots(c, state);
      return c.json(state ? toResponse(state) : ({ status: "not_eligible" } satisfies GetStartedResponse));
    } catch (err) {
      if (err instanceof OwnerFileMutationBusyError) return c.json({ error: LOAD_ERROR }, 503);
      console.warn("[get-started] Failed to read state:", errorName(err));
      return c.json({ error: LOAD_ERROR }, 500);
    }
  });

  // Spec 636, Part B: only while setup is open; the wizard falls back to built-in names on any error.
  app.post("/bot-names", bodyLimit({ maxSize: BOT_NAMES_BODY_LIMIT, onError: (c) => c.json({ error: "Request too large" }, 413) }), async (c) => {
    if (!enabled) return c.json({ error: "Get started is not available" }, 404);
    let state: GetStartedState | null;
    try {
      state = await withPinnedSystemDir(homePath, readState);
    } catch (err) {
      console.warn("[get-started] Failed to read state:", errorName(err));
      return c.json({ error: LOAD_ERROR }, 500);
    }
    if (!state) return c.json({ error: "Get started is not available" }, 404);
    if (isTerminal(state)) return c.json({ error: "Setup is already finished" }, 409);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = GetStartedBotNamesRequestSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    if (!opts.suggestBotNames) return c.json({ error: BOT_NAMES_ERROR }, 503);
    try {
      return c.json(await opts.suggestBotNames(parsed.data, c.req.raw.signal));
    } catch (err) {
      console.warn("[get-started] Bot name suggestions unavailable:", errorName(err));
      return c.json({ error: BOT_NAMES_ERROR }, 503);
    }
  });

  app.put("/", bodyLimit({ maxSize: PUT_BODY_LIMIT }), async (c) => {
    if (!enabled) return c.json({ error: "Get started is not available" }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch (err) {
      // Anything but malformed JSON (e.g. the streamed body limit) belongs to the middleware.
      if (!(err instanceof SyntaxError)) throw err;
      return c.json({ error: "Invalid request" }, 400);
    }
    const parsed = GetStartedUpdateSchema.safeParse(raw);
    if (!parsed.success) return c.json({ error: "Invalid request" }, 400);
    const update: GetStartedUpdate = parsed.data;

    try {
      const result = await withOwnerFileMutation(homePath, async () => {
        const saved = await withPinnedSystemDir(homePath, async (dir) => {
          const current = await readState(dir);
          if (!current) return null;
          const transition = transitionGetStarted(current, update, now());
          if (transition.kind === "conflict") return transition;
          // The owner's choices are written before setup is saved as completed, so a failed
          // SOUL write leaves setup unfinished and the wizard offers a retry. Idempotent: a
          // repeated completion reapplies them.
          const next = transition.state;
          if (next.status === "completed" && next.answers.bot) {
            await applyGetStartedPersonality(homePath, { ...next.answers, bot: next.answers.bot });
          }
          if (transition.kind === "write") await dir.writeAtomic(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 0o644);
          if (isTerminal(next)) await ensureOnboardingMarker(dir, now().toISOString());
          return transition;
        });
        return saved ?? ({ kind: "not_eligible" } as const);
      });
      if (result.kind === "not_eligible") return c.json({ error: "Get started is not available" }, 404);
      if (result.kind === "conflict") return c.json({ error: "Your setup is already finished" }, 409);
      // Outside the file lock: bot creation touches the database and has its own idempotency.
      // A failure keeps the saved choice, so a later read or POST /bots retries it.
      if (result.state.status === "completed" && savedBotJobs(result.state.answers).length > 0 && opts.ensureBot) {
        const ownerId = opts.getOwnerId?.(c) ?? null;
        if (!ownerId) console.warn("[get-started] Bots skipped: no request principal");
        else {
          markEnsured(ownerId);
          await ensureSavedBots(ownerId, result.state.answers);
        }
      }
      return c.json(toResponse(result.state));
    } catch (err) {
      if (err instanceof OwnerFileMutationBusyError) return c.json({ error: SAVE_ERROR }, 503);
      console.warn("[get-started] Failed to save state:", errorName(err));
      return c.json({ error: SAVE_ERROR }, 500);
    }
  });

  /**
   * Spec 635: what each saved bot choice made, so Getting started uses that bot (and tells one the
   * owner removed from one whose creation never finished, "pending", offered as Create).
   */
  app.get("/bots", async (c) => {
    if (!enabled) return c.json({ error: "Get started is not available" }, 404);
    const botStatus = opts.botStatus;
    if (!botStatus) return c.json({ error: BOTS_ERROR }, 503);
    const ownerId = opts.getOwnerId?.(c) ?? null;
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    let state: GetStartedState | null;
    try {
      state = await withPinnedSystemDir(homePath, readState);
    } catch (err) {
      console.warn("[get-started] Failed to read state:", errorName(err));
      return c.json({ error: LOAD_ERROR }, 500);
    }
    if (state?.status !== "completed") return c.json({ error: "Get started is not finished" }, 404);
    try {
      const bots: Record<string, GetStartedSavedBot> = {};
      for (const job of savedBotJobs(state.answers)) bots[job.recipeId] = await botStatus(ownerId, job.recipeId);
      return c.json({ bots });
    } catch (err) {
      console.warn("[get-started] Bot status unavailable:", errorName(err));
      return c.json({ error: BOTS_ERROR }, 503);
    }
  });

  /** Spec 635: retries the saved bot choices on request, e.g. from Getting started's Create action. */
  app.post("/bots", bodyLimit({ maxSize: PUT_BODY_LIMIT }), async (c) => {
    if (!enabled) return c.json({ error: "Get started is not available" }, 404);
    if (!opts.ensureBot) return c.json({ error: BOTS_ERROR }, 503);
    const ownerId = opts.getOwnerId?.(c) ?? null;
    if (!ownerId) return c.json({ error: "Unauthorized" }, 401);
    let state: GetStartedState | null;
    try {
      state = await withPinnedSystemDir(homePath, readState);
    } catch (err) {
      console.warn("[get-started] Failed to read state:", errorName(err));
      return c.json({ error: LOAD_ERROR }, 500);
    }
    if (state?.status !== "completed") return c.json({ error: "Get started is not finished" }, 404);
    markEnsured(ownerId);
    return c.json({ bots: await ensureSavedBots(ownerId, state.answers) });
  });

  return app;
}
