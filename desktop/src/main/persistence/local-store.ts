// Local UI state (FR-084): only recreatable data lives here — profile pointer,
// window bounds, panel layouts, appearance. Atomic writes (tmp + rename),
// schema-validated keys, bounded panel-layout retention.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod/v4";
import { ProjectViewsStateSchema } from "../../shared/project-views";

export const PANEL_LAYOUT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const AppearanceSchema = z
  .object({ theme: z.enum(["dark", "light", "system"]) })
  .strict();

const WindowBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const PanelLayoutSchema = z
  .object({
    order: z.array(z.string().max(32)).max(12),
    visible: z.record(z.string().max(32), z.boolean()),
    sizes: z.record(z.string().max(32), z.number().min(0).max(100)),
    touchedAt: z.number().int().nonnegative(),
  })
  .strict();

const PanelLayoutsSchema = z.record(z.string().max(256), PanelLayoutSchema);

const RecentsSchema = z.array(z.string().max(512)).max(50);

const ProviderPreferencesSchema = z
  .object({
    defaultProviderId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/)
      .nullable(),
  })
  .strict();

const ProfileSchema = z
  .object({
    handle: z.string().min(1).max(64),
    userId: z.string().min(1).max(128),
    platformHost: z.string().min(1).max(256),
    runtimeSlot: z.string().min(1).max(64),
    displayName: z.string().max(256).optional(),
    imageUrl: z.string().url().max(2048).optional(),
    email: z.string().max(320).optional(),
  })
  .strict();

const KEY_SCHEMAS = {
  profile: ProfileSchema,
  windowBounds: WindowBoundsSchema,
  lastProjectSlug: z.string().max(256),
  panelLayouts: PanelLayoutsSchema,
  appearance: AppearanceSchema,
  recents: RecentsSchema,
  projectViews: ProjectViewsStateSchema,
  providerPreferences: ProviderPreferencesSchema,
} as const;

export type LocalStoreKey = keyof typeof KEY_SCHEMAS;
export type LocalStoreValue<K extends LocalStoreKey> = z.infer<(typeof KEY_SCHEMAS)[K]>;
export type PanelLayout = z.infer<typeof PanelLayoutSchema>;

interface LocalStoreOptions {
  dir: string;
  clock?: () => number;
}

export interface LocalStore {
  get<K extends LocalStoreKey>(key: K): Promise<LocalStoreValue<K> | null>;
  set<K extends LocalStoreKey>(key: K, value: LocalStoreValue<K>): Promise<void>;
  setUnknown(key: LocalStoreKey, value: unknown): Promise<void>;
  delete(key: LocalStoreKey): Promise<void>;
  setPanelLayout(taskKey: string, layout: PanelLayout): Promise<void>;
}

export function createLocalStore(options: LocalStoreOptions): LocalStore {
  const filePath = join(options.dir, "state.json");
  const clock = options.clock ?? Date.now;
  // Serialize writes so concurrent set() calls cannot interleave tmp files.
  let writeChain: Promise<void> = Promise.resolve();

  async function readState(): Promise<Record<string, unknown>> {
    try {
      const raw = await readFile(filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return {};
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // Corrupt or unreadable state is recoverable: start fresh, keep the
        // bad file out of the way rather than crashing the app.
        console.warn(
          "[local-store] unreadable state file, starting fresh:",
          err instanceof Error ? err.message : String(err),
        );
      }
      return {};
    }
  }

  async function writeState(state: Record<string, unknown>): Promise<void> {
    await mkdir(options.dir, { recursive: true });
    const tmpPath = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(tmpPath, JSON.stringify(state, null, 2), "utf8");
    await rename(tmpPath, filePath);
  }

  function enqueue(mutate: (state: Record<string, unknown>) => void): Promise<void> {
    const task = writeChain.then(async () => {
      const state = await readState();
      mutate(state);
      await writeState(state);
    });
    // Keep the chain alive even if a write fails; the failure still
    // propagates to this call's awaiter.
    writeChain = task.catch(() => undefined);
    return task;
  }

  function prunePanelLayouts(
    layouts: Record<string, PanelLayout>,
    now: number,
  ): Record<string, PanelLayout> {
    const pruned: Record<string, PanelLayout> = {};
    for (const [key, layout] of Object.entries(layouts)) {
      if (now - layout.touchedAt <= PANEL_LAYOUT_MAX_AGE_MS) {
        pruned[key] = layout;
      }
    }
    return pruned;
  }

  return {
    async get(key) {
      const state = await readState();
      const result = KEY_SCHEMAS[key].safeParse(state[key]);
      if (!result.success) return null;
      return result.data as LocalStoreValue<typeof key> | null;
    },

    async set(key, value) {
      const parsed = KEY_SCHEMAS[key].parse(value);
      await enqueue((state) => {
        state[key] = parsed;
      });
    },

    async setUnknown(key, value) {
      const parsed = KEY_SCHEMAS[key].parse(value);
      await enqueue((state) => {
        state[key] = parsed;
      });
    },

    async delete(key) {
      await enqueue((state) => {
        delete state[key];
      });
    },

    async setPanelLayout(taskKey, layout) {
      const parsedLayout = PanelLayoutSchema.parse(layout);
      await enqueue((state) => {
        const existing = PanelLayoutsSchema.safeParse(state.panelLayouts);
        const layouts = existing.success ? existing.data : {};
        layouts[taskKey.slice(0, 256)] = parsedLayout;
        state.panelLayouts = prunePanelLayouts(layouts, clock());
      });
    },
  };
}
