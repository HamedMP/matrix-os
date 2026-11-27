import { spawn as spawnProcess } from "node:child_process";
import { z } from "zod/v4";
import type { ZellijObserver, ZellijObserverEvent } from "./runtime.js";
import { decodeZellijScreenDump } from "./zellij-screen-dump.js";

const MAX_SUBSCRIPTION_LINE_BYTES = 1024 * 1024;
const FINAL_SCREEN_DUMP_TIMEOUT_MS = 1_000;
export const ZELLIJ_PANE_ID = /^terminal_[0-9]+$/;

const SubscribeEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("pane_update"),
    pane_id: z.string().regex(ZELLIJ_PANE_ID),
    viewport: z.array(z.string().max(16_384)).max(200),
    scrollback: z.array(z.string().max(16_384)).max(100_000).nullable().optional(),
    is_initial: z.boolean().optional(),
  }).strict(),
  z.object({ event: z.literal("pane_closed"), pane_id: z.string().regex(ZELLIJ_PANE_ID) }).strict(),
]);
type PaneUpdate = Extract<z.infer<typeof SubscribeEventSchema>, { event: "pane_update" }>;

export interface RuntimeSubscriptionProcess {
  close(): Promise<void>;
}

export function createZellijObserver(input: {
  onEvent: (event: ZellijObserverEvent) => void;
  dumpPane: (paneId: string, signal: AbortSignal) => Promise<string>;
  spawn: (
    onLine: (line: string) => void,
    onExit: (exitCode: number | null) => void,
  ) => RuntimeSubscriptionProcess;
}): ZellijObserver {
  const snapshots = new AbortController();
  let eventChain = Promise.resolve();
  let exited = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let activeUpdate: PaneUpdate | undefined;
  let finalPaneId: string | undefined;
  let finalUpdate: PaneUpdate | undefined;
  const publishUpdate = (event: PaneUpdate, ansi: string) => {
    const fullLines = ansi.split(/\r?\n/);
    const scrollback = event.scrollback ?? fullLines.slice(0, Math.max(0, fullLines.length - event.viewport.length));
    input.onEvent({ type: "pane-update", paneId: event.pane_id, ansi, viewport: event.viewport, scrollback });
  };
  const captureUpdate = async (event: PaneUpdate, signal: AbortSignal) => {
    const dump = await input.dumpPane(event.pane_id, signal);
    signal.throwIfAborted();
    publishUpdate(event, decodeZellijScreenDump(dump, event.scrollback));
  };
  const captureFinalUpdate = async (event: PaneUpdate) => {
    try {
      await captureUpdate(event, AbortSignal.timeout(FINAL_SCREEN_DUMP_TIMEOUT_MS));
    } catch (error) {
      console.warn("[terminal-runtime] final Zellij screen dump unavailable", error instanceof Error ? error.name : "unknown_error");
      // Complete subscription rows can still preserve the command's output.
      // Without history, keep the previous checkpoint instead of truncating it.
      if (event.scrollback) publishUpdate(event, [...event.scrollback, ...event.viewport].join("\r\n"));
    }
  };
  const onLine = (line: string) => {
    if (closing || Buffer.byteLength(line) > MAX_SUBSCRIPTION_LINE_BYTES) return;
    const parsed = SubscribeEventSchema.safeParse(safeJson(line));
    if (!parsed.success) {
      console.error("[terminal-runtime] rejected invalid Zellij observer event", parsed.error.issues.map((issue) => issue.path.join(".")));
      return;
    }
    eventChain = eventChain.then(async () => {
      const event = parsed.data;
      if (event.event === "pane_closed") {
        input.onEvent({ type: "pane-closed", paneId: event.pane_id });
        return;
      }
      if (snapshots.signal.aborted) {
        if (event.pane_id === finalPaneId) finalUpdate = event;
        return;
      }
      activeUpdate = event;
      try { await captureUpdate(event, snapshots.signal); }
      finally { activeUpdate = undefined; }
    }).catch((error: unknown) => {
      if (!snapshots.signal.aborted || error !== snapshots.signal.reason) {
        console.error("[terminal-runtime] Zellij observer update failed", error);
      }
    });
  };
  const process = input.spawn(onLine, (exitCode) => {
    exited = true;
    if (!closing && exitCode !== 0 && exitCode !== null) {
      console.error("[terminal-runtime] Zellij observer exited unexpectedly", exitCode);
    }
  });
  return {
    get closed() { return closing || exited; },
    close: ({ discardPendingSnapshots = false, finalPaneId: endedPaneId } = {}) => {
      closing = true;
      // Replacing an observer can discard redundant snapshots. Drain
      // pane-close events already received so terminal exits stay durable.
      if (discardPendingSnapshots && !snapshots.signal.aborted) {
        finalPaneId = endedPaneId;
        if (activeUpdate?.pane_id === finalPaneId) finalUpdate = activeUpdate;
        snapshots.abort();
      }
      closePromise ??= (async () => {
        try { await process.close(); }
        finally {
          await eventChain;
          if (finalUpdate) await captureFinalUpdate(finalUpdate);
        }
      })();
      return closePromise;
    },
  };
}

export function spawnLineProcess(
  binaryPath: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  onLine: (line: string) => void,
  onExit: (exitCode: number | null) => void,
): RuntimeSubscriptionProcess {
  const child = spawnProcess(binaryPath, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] });
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > MAX_SUBSCRIPTION_LINE_BYTES * 2) {
      buffer = "";
      return;
    }
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  });
  child.once("exit", onExit);
  return {
    close: async () => {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve(); }, 2_000);
        timer.unref();
        child.once("exit", () => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

function safeJson(line: string): unknown {
  try {
    return JSON.parse(line);
  } catch (error) {
    console.warn(
      "[terminal-runtime] rejected malformed Zellij observer JSON",
      error instanceof Error ? error.name : "unknown_error",
    );
    return null;
  }
}
