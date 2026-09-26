import { relative } from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { waitForWatcherReady } from "./home-mirror-io.js";

export interface HomeMirrorWatcherOptions {
  homeRoot: string;
  /** Directory pruning only; event handlers apply the file-level policy. */
  pruned: (relPath: string) => boolean;
  onEvent: (kind: "push" | "delete", relPath: string) => void;
  onError: (message: string) => void;
  /** False once the owning lifecycle generation has stopped or restarted. */
  isCurrent: (generation: number) => boolean;
  onReady?: () => void;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Owns the home mirror's chokidar watcher. Watcher creation and policy
 * rebuilds run on one serialized task chain, so at most one replacement
 * exists at a time; a replacement is ready before the previous watcher
 * closes, so no local events fall into a gap.
 */
export class HomeMirrorWatcher {
  private live: FSWatcher | null = null;
  private pending: FSWatcher | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly opts: HomeMirrorWatcherOptions) {}

  /** Serialize a watcher task; failures are reported and returned to the caller. */
  run(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task, task);
    this.chain = next.catch((err: unknown) => {
      this.opts.onError(`home mirror watcher task failed: ${errorMessage(err)}`);
    });
    return next;
  }

  /** Resolves once every queued watcher task has settled. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Swap in a watcher built from the current policy. */
  async replace(generation: number): Promise<void> {
    const next = await this.start(generation);
    if (!next) return;
    const previous = this.live;
    this.live = next;
    if (previous) await previous.close();
    if (!this.opts.isCurrent(generation)) return;
    this.opts.onReady?.();
  }

  async close(): Promise<void> {
    const watchers = [this.live, this.pending].filter((w): w is FSWatcher => w !== null);
    this.live = null;
    this.pending = null;
    await Promise.all(watchers.map((w) => w.close()));
  }

  // Start a watcher and wait for its initial scan so writes immediately after
  // readiness are not missed on slow filesystems. Returns null when the
  // lifecycle ended while scanning.
  private async start(generation: number): Promise<FSWatcher | null> {
    const { homeRoot } = this.opts;
    const next = watch(homeRoot, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
      ignored: (absPath) => this.opts.pruned(relative(homeRoot, absPath)),
    });
    this.pending = next;
    next.on("add", (absPath) => this.opts.onEvent("push", relative(homeRoot, absPath)));
    next.on("change", (absPath) => this.opts.onEvent("push", relative(homeRoot, absPath)));
    next.on("unlink", (absPath) => this.opts.onEvent("delete", relative(homeRoot, absPath)));
    next.on("error", (err: unknown) => {
      this.opts.onError(`home mirror watcher error: ${errorMessage(err)}`);
    });
    try {
      await waitForWatcherReady(next);
    } catch (err: unknown) {
      if (this.pending === next) this.pending = null;
      await next.close();
      throw err;
    }
    if (this.pending === next) this.pending = null;
    if (!this.opts.isCurrent(generation)) {
      await next.close();
      return null;
    }
    return next;
  }
}
