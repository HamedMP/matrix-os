// What the owner allowed the paired computer to do on this desktop (spec 2716, D2).
// The link being on never runs anything by itself: starting a terminal or a
// program, a screenshot, and reading or typing into a terminal the link did
// not start each need a native approval here, unless the owner allowed Full
// Access for this desktop (2698's consent record, read fresh on every check).
// Terminals the link started are covered by their start approval. Lives for one
// pairing revision; Stop, disconnect and re-pairing start over.

import { DESKTOP_LINK_APPROVAL_TIMEOUT_MS } from "@matrix-os/contracts/desktop-link";

/** What the native approval names. Every string here is already made visible (`renderVisible`). */
export type DesktopLinkConsentRequest =
  | { kind: "run"; command: string; cwd: string }
  | { kind: "terminal"; action: "open" | "end"; terminal: string; title: string; program: string; cwd: string }
  | { kind: "screenshot" };

export interface DesktopLinkConsentOptions {
  /** Shows the native approval; resolves true only on an explicit Allow. */
  ask(request: DesktopLinkConsentRequest, signal: AbortSignal): Promise<boolean>;
  /** The owner's Full Access for this desktop at the current pairing revision. */
  fullAccess(): Promise<boolean>;
  /** How long an approval may wait for the owner. */
  timeoutMs?: number;
  /** Pause between dialogs; replaced in tests. */
  dialogGapMs?: number;
  /** How long requests are refused without a dialog after the owner refused several in a row. */
  backoffMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** Terminals remembered as started or approved; older ones are forgotten first. */
const MAX_TERMINALS = 256;
/** Approvals waiting behind the one on screen; more are refused at once. */
const MAX_WAITING = 4;
const DEFAULT_TIMEOUT_MS = DESKTOP_LINK_APPROVAL_TIMEOUT_MS;
/** The longest command the approval shows; a longer one is refused, never shortened. */
export const MAX_COMMAND_CHARS = 500;
// Anything that would not show as itself: control and format characters (newlines,
// escapes, zero-width, direction marks, tags), separators other than a plain space,
// unpaired surrogates, private and unassigned code points, and filler letters.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{M}   -   　ᅟᅠ឴឵⠀ㅤﾠ]/gu;
// Words argv shows bare; anything else is single-quoted, so spaces and quotes read as they run.
const BARE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;
/** Pause between one approval closing and the next opening, so a second click never lands on it. */
const DIALOG_GAP_MS = 1_000;
/** Refusals (Don't Allow or no answer) in a row after which requests stop showing dialogs for a while. */
const REFUSALS_BEFORE_BACKOFF = 3;
const BACKOFF_MS = 30_000;
/**
 * A dialog the owner could have answered: one closed by anything but Stop after
 * this long counts as a refusal, and one with less time left than this never opens.
 */
const SEEN_MS = 500;
/** Dialogs one link may open per minute, whatever their answers; more are refused without one. */
const MAX_DIALOGS_PER_MINUTE = 10;
const MINUTE_MS = 60_000;

/**
 * Text from the computer as the approval shows it: every character that would not
 * show as itself (combining marks included) is written out as `⟨U+XXXX⟩`, and a
 * run of spaces as `⟨N spaces⟩`, so nothing is hidden, reordered, laid out to
 * look like the dialog's own text or pushed past its end. Null when the result
 * is longer than `max`: the request is then refused, never shortened.
 */
export function renderVisible(text: string, max = MAX_COMMAND_CHARS): string | null {
  const shown = text
    .replace(INVISIBLE, (char) => `⟨U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}⟩`)
    .replace(/ {2,}/g, (run) => `⟨${run.length} spaces⟩`);
  return shown.length > max ? null : shown;
}

function posixQuoted(part: string): string {
  return BARE_ARG.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`;
}

/** One argument as Windows joins argv into a command line (CommandLineToArgvW rules). */
export function windowsQuoted(part: string): string {
  if (part !== "" && !/[\s"]/.test(part)) return part;
  let out = '"';
  let slashes = 0;
  for (const char of part) {
    if (char === "\\") { slashes += 1; continue; }
    out += char === '"' ? "\\".repeat(slashes * 2 + 1) + '"' : "\\".repeat(slashes) + char;
    slashes = 0;
  }
  return `${out}${"\\".repeat(slashes * 2)}"`;
}

/**
 * The whole command a start runs, for the approval: argv quoted part by part the
 * way this desktop's OS reads it, a shell line as written.
 */
export function describeRun(params: { argv?: readonly string[]; line?: string }, platform: NodeJS.Platform = process.platform): string | null {
  if (params.argv && params.line) return null;
  const quote = platform === "win32" ? windowsQuoted : posixQuoted;
  const text = params.line ?? (params.argv ? params.argv.map(quote).join(" ") : null);
  if (text === null) return "your login shell";
  return renderVisible(text);
}

export function createDesktopLinkConsent(options: DesktopLinkConsentOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const dialogGapMs = options.dialogGapMs ?? DIALOG_GAP_MS;
  const backoffMs = options.backoffMs ?? BACKOFF_MS;
  const now = options.now ?? Date.now;
  // When the last dialog closed, refusals since the last Allow, and until when to ask nothing.
  let lastClosed = Number.NEGATIVE_INFINITY;
  let refusals = 0;
  let quietUntil = 0;
  // When recent dialogs opened (at most MAX_DIALOGS_PER_MINUTE entries).
  let opened: number[] = [];
  const log = options.log ?? ((message: string) => console.warn(`[desktop-link] ${message}`));
  // Terminal instances (`address@created_ms`), insertion-ordered so the oldest is forgotten
  // first. An address the core gives a new terminal (after a restart, say) is a new instance.
  const terminals = new Set<string>();
  let lifetime = new AbortController();
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  function remember(terminal: string): void {
    terminals.delete(terminal);
    terminals.add(terminal);
    while (terminals.size > MAX_TERMINALS) {
      const oldest = terminals.values().next().value;
      if (oldest === undefined) break;
      terminals.delete(oldest);
    }
  }

  async function fullAccess(): Promise<boolean> {
    try {
      return await options.fullAccess();
    } catch (error: unknown) {
      // An unreadable consent record is no consent.
      log(`full access unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);
      return false;
    }
  }

  /**
   * One approval on screen at a time, and Stop ends them all. Each request's
   * deadline starts when it arrives, not when its dialog shows, so one waiting
   * behind another never outlives the computer's call (spec 2716 deadlines).
   */
  /** Waits `ms`, or until `signal` aborts. */
  function pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
      signal.addEventListener("abort", done, { once: true });
    });
  }

  /**
   * One approval on screen at a time, a pause after each closes, and Stop ends
   * them all. Each request's deadline starts when it arrives, not when its dialog
   * shows (spec 2716 deadlines); `ended` (the stream it came on ended) cancels it
   * too, and an answer after any of these counts as no. After several refusals
   * in a row, requests are refused without a dialog for a while.
   */
  function approve(request: DesktopLinkConsentRequest, ended: AbortSignal | undefined, stopped: AbortSignal): Promise<boolean> {
    if (stopped.aborted || waiting >= MAX_WAITING || now() < quietUntil) return Promise.resolve(false);
    waiting += 1;
    const deadline = now() + timeoutMs;
    const signal = AbortSignal.any([stopped, AbortSignal.timeout(timeoutMs), ...(ended ? [ended] : [])]);
    const shown = queue.then(async () => {
      // Never under the owner's next click: always a pause after the last dialog closed.
      await pause(lastClosed + dialogGapMs - now(), signal);
      // Refusals may have started a quiet spell while this one waited; and a dialog
      // with almost no time left is never flashed up.
      if (signal.aborted || now() < quietUntil || deadline - now() < Math.min(SEEN_MS, timeoutMs / 2)) return false;
      const openedAt = now();
      opened = opened.filter((at) => openedAt - at < MINUTE_MS);
      if (opened.length >= MAX_DIALOGS_PER_MINUTE) return false;
      opened.push(openedAt);
      let allowed = false;
      try {
        allowed = (await options.ask(request, signal)) && !signal.aborted;
      } catch (error: unknown) {
        if (!signal.aborted) log(`approval failed: ${error instanceof Error ? error.name : "UnknownError"}`);
      }
      lastClosed = now();
      // Don't Allow, no answer, or the computer closing it counts; Stop does not, nor one closed before the owner could answer.
      const cancelled = stopped.aborted || (signal.aborted && lastClosed - openedAt < SEEN_MS);
      if (allowed) refusals = 0;
      else if (!cancelled && (refusals += 1) >= REFUSALS_BEFORE_BACKOFF) { refusals = 0; quietUntil = now() + backoffMs; }
      return allowed;
    });
    queue = shown.then(() => { waiting -= 1; });
    // Past its deadline a request is a no at once, even while it still waits for its turn.
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) { resolve(false); return; }
      signal.addEventListener("abort", () => resolve(false), { once: true });
      void shown.then(resolve);
    });
  }

  return {
    /** Starting a terminal or program: the exact command and folder, already made visible. */
    async run(request: { command: string; cwd: string }, ended?: AbortSignal): Promise<boolean> {
      // This request's own Stop, read before anything waits: reset() replaces the controller.
      const stopped = lifetime.signal;
      return (await fullAccess()) || approve({ kind: "run", ...request }, ended, stopped);
    },
    /** The core answered an approved start with this terminal instance: it is covered from now on. */
    started(instance: string): void {
      remember(instance);
    },
    /** Whether the link started this terminal instance, or the owner already approved it (no dialog needed). */
    covers(instance: string): boolean {
      return terminals.has(instance);
    },
    /** Reading, typing into or ending a terminal: free for instances the link started or the owner approved. */
    /** `instance` null: the core cannot tell this terminal from a later one, so its approval is never remembered. */
    async terminal(
      request: { instance: string | null; action: "open" | "end"; terminal: string; title: string; program: string; cwd: string },
      ended?: AbortSignal,
    ): Promise<boolean> {
      const stopped = lifetime.signal;
      if ((request.instance !== null && terminals.has(request.instance)) || (await fullAccess())) return true;
      const { instance, ...shown } = request;
      const allowed = await approve({ kind: "terminal", ...shown }, ended, stopped);
      // Only opening covers the terminal later; an approved end that did not end it covers nothing.
      if (allowed && instance !== null && request.action === "open") remember(instance);
      return allowed;
    },
    async screenshot(ended?: AbortSignal): Promise<boolean> {
      const stopped = lifetime.signal;
      return (await fullAccess()) || approve({ kind: "screenshot" }, ended, stopped);
    },
    /** Stop, disconnect or a new pairing revision: every approval on screen ends, nothing is remembered. */
    reset(): void {
      lifetime.abort();
      lifetime = new AbortController();
      terminals.clear();
      // A new start: no quiet spell carries over.
      refusals = 0;
      quietUntil = 0;
    },
  };
}

export type DesktopLinkConsent = ReturnType<typeof createDesktopLinkConsent>;
