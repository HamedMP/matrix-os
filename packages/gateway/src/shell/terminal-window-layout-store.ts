import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod/v4";
import { writeUtf8FileAtomic } from "./atomic-write.js";
import { SESSION_NAME_PATTERN } from "./names.js";

export const TerminalWindowLayoutIdSchema = z.string().regex(/^term-layout_[0-9a-f]{32}$/);
const SessionNameSchema = z.string().regex(SESSION_NAME_PATTERN);
const BOUNDED_ID = z.string().min(1).max(128);
const MAX_LAYOUTS = 64;
const MAX_TABS = 32;
const MAX_PANES = 64;
const MAX_TREE_DEPTH = 10;
const MAX_TOMBSTONES = 256;
const TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

const PaneSchema = z.object({
  type: z.literal("pane"),
  id: BOUNDED_ID,
  cwd: z.string().min(1).max(4096),
  sessionId: z.string().min(1).max(128).optional(),
  claudeMode: z.boolean().optional(),
  startupCommand: z.string().min(1).max(4096).optional(),
  compatMode: z.literal("codex-tui").optional(),
}).strict();

type TerminalPaneNode = z.infer<typeof PaneSchema> | {
  type: "split";
  direction: "horizontal" | "vertical";
  children: [TerminalPaneNode, TerminalPaneNode];
  ratio: number;
};

const PaneNodeSchema: z.ZodType<TerminalPaneNode> = z.lazy(() => z.union([
  PaneSchema,
  z.object({
    type: z.literal("split"),
    direction: z.enum(["horizontal", "vertical"]),
    children: z.tuple([PaneNodeSchema, PaneNodeSchema]),
    ratio: z.number().min(0.05).max(0.95),
  }).strict(),
]));

const TerminalTabSchema = z.object({
  id: BOUNDED_ID,
  label: z.string().max(128),
  paneTree: PaneNodeSchema,
}).strict();

function paneTreeWithinLimits(node: TerminalPaneNode, depth = 0): { panes: number; valid: boolean } {
  if (depth > MAX_TREE_DEPTH) return { panes: 0, valid: false };
  if (node.type === "pane") return { panes: 1, valid: true };
  const left = paneTreeWithinLimits(node.children[0], depth + 1);
  const right = paneTreeWithinLimits(node.children[1], depth + 1);
  return {
    panes: left.panes + right.panes,
    valid: left.valid && right.valid && left.panes + right.panes <= MAX_PANES,
  };
}

export const TerminalWindowLayoutSchema = z.object({
  tabs: z.array(TerminalTabSchema).max(MAX_TABS),
  activeTabId: BOUNDED_ID.or(z.literal("")),
  sidebarOpen: z.boolean().optional(),
}).strict().superRefine((layout, ctx) => {
  const paneCount = layout.tabs.reduce((count, tab) => {
    const result = paneTreeWithinLimits(tab.paneTree);
    if (!result.valid) {
      ctx.addIssue({ code: "custom", message: "Pane tree exceeds limits" });
    }
    return count + result.panes;
  }, 0);
  if (paneCount > MAX_PANES) {
    ctx.addIssue({ code: "custom", message: "Layout has too many panes" });
  }
});

export type TerminalWindowLayout = z.infer<typeof TerminalWindowLayoutSchema>;

const PersistedLayoutSchema = z.object({
  revision: z.number().int().nonnegative(),
  updatedAt: z.iso.datetime(),
  layout: TerminalWindowLayoutSchema,
}).strict();

const TombstoneSchema = z.object({
  sessionName: SessionNameSchema,
  deletedAt: z.iso.datetime(),
}).strict();

const StateSchema = z.object({
  version: z.literal(1),
  layouts: z.record(TerminalWindowLayoutIdSchema, PersistedLayoutSchema),
  tombstones: z.array(TombstoneSchema).max(MAX_TOMBSTONES),
}).strict();

type TerminalLayoutState = z.infer<typeof StateSchema>;

function emptyState(): TerminalLayoutState {
  return { version: 1, layouts: {}, tombstones: [] };
}

function emptyLayout(): TerminalWindowLayout {
  return { tabs: [], activeTabId: "", sidebarOpen: true };
}

function isErrnoCode(err: unknown, code: string): boolean {
  return err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === code;
}

function removeSessionFromPaneTree(node: TerminalPaneNode, sessionName: string): TerminalPaneNode | null {
  if (node.type === "pane") {
    return node.sessionId === sessionName ? null : node;
  }
  const left = removeSessionFromPaneTree(node.children[0], sessionName);
  const right = removeSessionFromPaneTree(node.children[1], sessionName);
  if (!left) return right;
  if (!right) return left;
  if (left === node.children[0] && right === node.children[1]) return node;
  return { ...node, children: [left, right] };
}

function removeSessionFromLayout(layout: TerminalWindowLayout, sessionName: string): TerminalWindowLayout {
  let changed = false;
  const tabs = layout.tabs.flatMap((tab) => {
    const paneTree = removeSessionFromPaneTree(tab.paneTree, sessionName);
    if (paneTree === tab.paneTree) return [tab];
    changed = true;
    return paneTree ? [{ ...tab, paneTree }] : [];
  });
  if (!changed) return layout;
  return {
    ...layout,
    tabs,
    activeTabId: tabs.some((tab) => tab.id === layout.activeTabId)
      ? layout.activeTabId
      : tabs[0]?.id ?? "",
  };
}

export class TerminalLayoutRevisionConflictError extends Error {
  constructor() {
    super("Terminal layout revision conflict");
    this.name = "TerminalLayoutRevisionConflictError";
  }
}

export class TerminalWindowLayoutStore {
  private readonly statePath: string;
  private readonly legacyLayoutPath: string;
  private readonly now: () => Date;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: { homePath: string; now?: () => Date }) {
    this.statePath = join(resolve(options.homePath), "system", "terminal-window-layouts.json");
    this.legacyLayoutPath = join(resolve(options.homePath), "system", "terminal-layout.json");
    this.now = options.now ?? (() => new Date());
  }

  async get(layoutId: string): Promise<{ layoutId: string; revision: number; layout: TerminalWindowLayout }> {
    const safeLayoutId = TerminalWindowLayoutIdSchema.parse(layoutId);
    return this.withMutationLock(async () => {
      const state = await this.read(safeLayoutId);
      const pruned = this.pruneTombstones(state);
      const entry = pruned.state.layouts[safeLayoutId];
      if (pruned.changed) await this.write(pruned.state);
      console.info("[terminal-layout]", {
        event: "terminal.layout.read",
        layoutId: safeLayoutId,
        revision: entry?.revision ?? 0,
      });
      return {
        layoutId: safeLayoutId,
        revision: entry?.revision ?? 0,
        layout: entry?.layout ?? emptyLayout(),
      };
    });
  }

  async put(
    layoutId: string,
    baseRevision: number,
    input: unknown,
  ): Promise<{ layoutId: string; revision: number; layout: TerminalWindowLayout }> {
    const safeLayoutId = TerminalWindowLayoutIdSchema.parse(layoutId);
    const safeBaseRevision = z.number().int().nonnegative().parse(baseRevision);
    const parsedLayout = TerminalWindowLayoutSchema.parse(input);
    return this.withMutationLock(async () => {
      const pruned = this.pruneTombstones(await this.read());
      const state = pruned.state;
      const currentRevision = state.layouts[safeLayoutId]?.revision ?? 0;
      if (currentRevision !== safeBaseRevision) {
        console.info("[terminal-layout]", {
          event: "terminal.layout.conflict",
          layoutId: safeLayoutId,
          revision: currentRevision,
        });
        throw new TerminalLayoutRevisionConflictError();
      }
      const tombstonedNames = new Set(state.tombstones.map((entry) => entry.sessionName));
      let layout = parsedLayout;
      for (const sessionName of tombstonedNames) {
        layout = removeSessionFromLayout(layout, sessionName);
      }
      if (!state.layouts[safeLayoutId] && Object.keys(state.layouts).length >= MAX_LAYOUTS) {
        const oldest = Object.entries(state.layouts)
          .sort((left, right) => left[1].updatedAt.localeCompare(right[1].updatedAt))[0]?.[0];
        if (oldest) delete state.layouts[oldest];
      }
      const revision = currentRevision + 1;
      state.layouts[safeLayoutId] = {
        revision,
        updatedAt: this.now().toISOString(),
        layout,
      };
      await this.write(state);
      console.info("[terminal-layout]", {
        event: "terminal.layout.write",
        layoutId: safeLayoutId,
        revision,
      });
      return { layoutId: safeLayoutId, revision, layout };
    });
  }

  async deleteLayout(layoutId: string): Promise<void> {
    const safeLayoutId = TerminalWindowLayoutIdSchema.parse(layoutId);
    return this.withMutationLock(async () => {
      const state = await this.read();
      if (!(safeLayoutId in state.layouts)) return;
      delete state.layouts[safeLayoutId];
      await this.write(state);
    });
  }

  async deleteSessionReferences(sessionName: string): Promise<void> {
    const safeSessionName = SessionNameSchema.parse(sessionName);
    return this.withMutationLock(async () => {
      const state = this.pruneTombstones(await this.read()).state;
      const deletedAt = this.now().toISOString();
      state.tombstones = [
        ...state.tombstones.filter((entry) => entry.sessionName !== safeSessionName),
        { sessionName: safeSessionName, deletedAt },
      ].slice(-MAX_TOMBSTONES);
      let reconciledLayouts = 0;
      for (const [layoutId, entry] of Object.entries(state.layouts)) {
        const layout = removeSessionFromLayout(entry.layout, safeSessionName);
        if (layout === entry.layout) continue;
        reconciledLayouts += 1;
        state.layouts[layoutId] = {
          revision: entry.revision + 1,
          updatedAt: deletedAt,
          layout,
        };
      }
      await this.write(state);
      console.info("[terminal-layout]", {
        event: "terminal.layout.reconciled",
        sessionName: safeSessionName,
        layouts: reconciledLayouts,
      });
    });
  }

  async clearSessionTombstone(sessionName: string): Promise<void> {
    const safeSessionName = SessionNameSchema.parse(sessionName);
    return this.withMutationLock(async () => {
      const state = this.pruneTombstones(await this.read()).state;
      const next = state.tombstones.filter((entry) => entry.sessionName !== safeSessionName);
      if (next.length === state.tombstones.length) return;
      state.tombstones = next;
      await this.write(state);
    });
  }

  async listSessionTombstones(): Promise<string[]> {
    return this.withMutationLock(async () => {
      const pruned = this.pruneTombstones(await this.read());
      if (pruned.changed) await this.write(pruned.state);
      return pruned.state.tombstones.map((entry) => entry.sessionName);
    });
  }

  async isSessionTombstoned(sessionName: string): Promise<boolean> {
    const safeSessionName = SessionNameSchema.parse(sessionName);
    return this.withMutationLock(async () => {
      const pruned = this.pruneTombstones(await this.read());
      if (pruned.changed) await this.write(pruned.state);
      return pruned.state.tombstones.some((entry) => entry.sessionName === safeSessionName);
    });
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release!: () => void;
    this.mutationTail = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async read(migrateLegacyToLayoutId?: string): Promise<TerminalLayoutState> {
    let raw: string;
    try {
      raw = await readFile(this.statePath, "utf8");
    } catch (err: unknown) {
      if (isErrnoCode(err, "ENOENT")) {
        if (!migrateLegacyToLayoutId) return emptyState();
        try {
          const legacy = TerminalWindowLayoutSchema.parse(JSON.parse(
            await readFile(this.legacyLayoutPath, "utf8"),
          ));
          const state = emptyState();
          state.layouts[migrateLegacyToLayoutId] = {
            revision: 1,
            updatedAt: this.now().toISOString(),
            layout: legacy,
          };
          await this.write(state);
          console.info("[terminal-layout]", {
            event: "terminal.layout.migrated",
            layoutId: migrateLegacyToLayoutId,
          });
          return state;
        } catch (legacyErr: unknown) {
          if (isErrnoCode(legacyErr, "ENOENT")) return emptyState();
          console.warn("[terminal-layout] legacy layout migration skipped:", legacyErr instanceof Error ? legacyErr.name : "UnknownError");
          return emptyState();
        }
      }
      throw err;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch (err: unknown) {
      throw new Error("Invalid terminal window layout state", { cause: err });
    }
    const parsed = StateSchema.safeParse(decoded);
    if (!parsed.success) throw new Error("Invalid terminal window layout state");
    return parsed.data;
  }

  private async write(state: TerminalLayoutState): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true, mode: 0o700 });
    await writeUtf8FileAtomic(this.statePath, `${JSON.stringify(StateSchema.parse(state), null, 2)}\n`, 0o600);
  }

  private pruneTombstones(state: TerminalLayoutState): { state: TerminalLayoutState; changed: boolean } {
    const cutoff = this.now().getTime() - TOMBSTONE_TTL_MS;
    const tombstones = state.tombstones.filter((entry) => Date.parse(entry.deletedAt) >= cutoff);
    return tombstones.length === state.tombstones.length
      ? { state, changed: false }
      : { state: { ...state, tombstones }, changed: true };
  }
}
