import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  GetStartedStateSchema,
  GetStartedUpdateSchema,
  type GetStartedResponse,
  type GetStartedState,
  type GetStartedUpdate,
} from "@matrix-os/contracts";
import { withPinnedSystemDir, type PinnedSystemDir } from "../get-started/owner-system-dir.js";
import { OwnerFileMutationBusyError, withOwnerFileMutation } from "../owner-file-mutations.js";

// Spec 635, Section 1. The state file is only ever created for new homes
// (Section 2), so a missing file means "not eligible", never "pending". Both files
// live in the owner's `system` directory, read and written only through its pin.
const STATE_FILE = "get-started.json";
const ONBOARDING_COMPLETE_FILE = "onboarding-complete.json";
const PUT_BODY_LIMIT = 8 * 1024;
const STATE_FILE_MAX_BYTES = 16 * 1024;

const LOAD_ERROR = "Unable to load your setup";
const SAVE_ERROR = "Unable to save your setup";

export interface GetStartedRoutesOptions {
  homePath: string;
  /** Kill switch (`MATRIX_GET_STARTED_ENABLED`). When false every home reads as not eligible. */
  enabled: boolean;
  now?: () => Date;
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

  app.get("/", async (c) => {
    if (!enabled) return c.json({ status: "not_eligible" } satisfies GetStartedResponse);
    try {
      const state = await withPinnedSystemDir(homePath, readState);
      return c.json(state ? toResponse(state) : ({ status: "not_eligible" } satisfies GetStartedResponse));
    } catch (err) {
      console.warn("[get-started] Failed to read state:", errorName(err));
      return c.json({ error: LOAD_ERROR }, 500);
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
          if (transition.kind === "write") await dir.writeAtomic(STATE_FILE, `${JSON.stringify(transition.state, null, 2)}\n`, 0o644);
          if (transition.kind !== "conflict" && isTerminal(transition.state)) {
            await ensureOnboardingMarker(dir, now().toISOString());
          }
          return transition;
        });
        return saved ?? ({ kind: "not_eligible" } as const);
      });
      if (result.kind === "not_eligible") return c.json({ error: "Get started is not available" }, 404);
      if (result.kind === "conflict") return c.json({ error: "Your setup is already finished" }, 409);
      return c.json(toResponse(result.state));
    } catch (err) {
      if (err instanceof OwnerFileMutationBusyError) return c.json({ error: SAVE_ERROR }, 503);
      console.warn("[get-started] Failed to save state:", errorName(err));
      return c.json({ error: SAVE_ERROR }, 500);
    }
  });

  return app;
}
