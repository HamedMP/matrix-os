/**
 * Pane sizes, kept in the app's key-value store (the sandbox has no
 * localStorage). Reads tolerate junk; writes are debounced and best effort.
 */

export interface MailLayout {
  /** Width of the folder rail in px. */
  rail: number;
  /** Width of the thread list in px. */
  list: number;
}

export const LAYOUT_KEY = "mail-layout";
export const DEFAULT_LAYOUT: MailLayout = Object.freeze({ rail: 232, list: 400 }) as MailLayout;
export const LAYOUT_LIMITS = Object.freeze({ rail: { min: 160, max: 480 }, list: { min: 280, max: 900 } });
const SAVE_DELAY_MS = 400;

function clampNumber(value: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function clampLayout(layout: MailLayout): MailLayout {
  return {
    rail: clampNumber(layout.rail, LAYOUT_LIMITS.rail.min, LAYOUT_LIMITS.rail.max),
    list: clampNumber(layout.list, LAYOUT_LIMITS.list.min, LAYOUT_LIMITS.list.max),
  };
}

export function parseLayout(value: unknown): MailLayout {
  if (typeof value !== "object" || value === null) return DEFAULT_LAYOUT;
  const record = value as Record<string, unknown>;
  const pick = (key: keyof MailLayout) => {
    const candidate = record[key];
    return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : DEFAULT_LAYOUT[key];
  };
  return clampLayout({ rail: pick("rail"), list: pick("list") });
}

export interface LayoutBridge {
  readData?: (key: string) => Promise<unknown>;
  writeData?: (key: string, value: unknown) => Promise<void>;
}

export interface LayoutStore {
  load(): Promise<MailLayout>;
  /** Queues a save; the last value within the delay wins. */
  save(layout: MailLayout): void;
  dispose(): void;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createLayoutStore(bridge: LayoutBridge | undefined, delayMs = SAVE_DELAY_MS): LayoutStore {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: MailLayout | null = null;
  const write = () => {
    timer = null;
    const value = pending;
    pending = null;
    if (!value || !bridge?.writeData) return;
    bridge.writeData(LAYOUT_KEY, value).catch((error: unknown) => {
      console.warn(`[mail] layout.save.failed (${errorName(error)})`);
    });
  };
  return {
    async load() {
      if (!bridge?.readData) return DEFAULT_LAYOUT;
      try {
        return parseLayout(await bridge.readData(LAYOUT_KEY));
      } catch (error: unknown) {
        console.warn(`[mail] layout.load.failed (${errorName(error)})`);
        return DEFAULT_LAYOUT;
      }
    },
    save(layout) {
      if (!bridge?.writeData) return;
      if (timer !== null) clearTimeout(timer);
      pending = clampLayout(layout);
      timer = setTimeout(write, delayMs);
    },
    /** Writes a queued save now and stops the timer. */
    dispose() {
      if (timer !== null) clearTimeout(timer);
      write();
    },
  };
}
