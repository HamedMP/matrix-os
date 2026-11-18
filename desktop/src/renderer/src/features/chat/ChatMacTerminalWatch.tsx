import { useLayoutEffect, useRef, useState } from "react";
import type { InvokeRequest, InvokeResponse } from "../../../../shared/ipc-contract";
import { invoke } from "../../lib/operator";
import type { ComposerMentionAction } from "./ComposerMentionActions";

type StartRequest = InvokeRequest<"chat:mac-terminal-watch-start">;
type StopRequest = InvokeRequest<"chat:mac-terminal-watch-stop">;
type WatchRef = InvokeRequest<"chat:mac-terminal-watch-read">;
type WatchApproval = Extract<InvokeResponse<"chat:mac-terminal-watch-start">, { status: "ready" }>;
type WatchScope = Omit<StartRequest, "requestId"> & { actorId: string; projectId: string };
type WatchOperation = {
  request: StartRequest;
  ref?: WatchRef;
  released?: boolean;
  pollTimer?: ReturnType<typeof setTimeout>;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
type WatchView = {
  key: string;
  status: string;
  busy?: boolean;
} | {
  key: string;
  terminal: WatchApproval;
};

const POLL_MS = 2_000;
const ENDED = "Mac terminal watch ended. Choose a terminal to watch again.";
const START_STATUS = {
  declined: "Mac terminal watch was declined.",
  unavailable: "Mac terminal watch is unavailable.",
  busy: "The Mac is already handling a terminal action.",
  failed: "Mac terminal watch could not start.",
};

function logFailure(error: unknown) {
  console.warn("[mac-terminal-watch] request failed", error instanceof Error ? error.name : "UnknownError");
}

async function stopNativeWatch(ref: StopRequest) {
  try {
    return await invoke("chat:mac-terminal-watch-stop", ref);
  } catch (error: unknown) {
    logFailure(error);
    return null;
  }
}

function release(operation: WatchOperation) {
  if (operation.released) return;
  operation.released = true;
  clearTimeout(operation.pollTimer);
  clearTimeout(operation.expiryTimer);
  return stopNativeWatch(operation.ref ?? operation.request);
}

export function useChatMacTerminalWatch(scope: WatchScope | null) {
  const key = scope && JSON.stringify([scope.actorId, scope.chatId, scope.projectId, scope.worktreeId]);
  const [view, setView] = useState<WatchView | null>(null);
  const activeScope = useRef<string | null>(null);
  const operation = useRef<WatchOperation | null>(null);

  useLayoutEffect(() => {
    activeScope.current = key;
    // Clear the last screen on scope exit, including when it will be reopened later.
    setView(previous => previous?.key === key ? previous : null);
    return () => {
      activeScope.current = null;
      if (operation.current) void release(operation.current);
      operation.current = null;
    };
  }, [key]);

  async function start() {
    if (!scope || !key || activeScope.current !== key || operation.current) return;
    const target = { chatId: scope.chatId, worktreeId: scope.worktreeId };
    const watch: WatchOperation = { request: { ...target, requestId: crypto.randomUUID() } };
    operation.current = watch;
    const isCurrent = () => !watch.released && operation.current === watch && activeScope.current === key;
    setView({ key, status: "Choose a terminal and approve watching on this Mac…", busy: true });

    try {
      const reply = await invoke("chat:mac-terminal-watch-start", watch.request);
      if (reply.status !== "ready") {
        if (isCurrent()) {
          operation.current = null;
          setView({ key, status: START_STATUS[reply.status] });
        }
        return;
      }

      const { output, ...terminal } = reply;
      const ref = { ...target, watchId: terminal.watchId };
      if (!isCurrent()) {
        await stopNativeWatch(ref);
        return;
      }

      watch.ref = ref;
      const lifetime = terminal.expiresAt - Date.now();

      const end = () => {
        if (!isCurrent()) return;
        operation.current = null;
        void release(watch);
        setView({ key, status: ENDED });
      };

      if (lifetime <= 0) {
        end();
        return;
      }

      const poll = async () => {
        if (!isCurrent()) return;
        try {
          const update = await invoke("chat:mac-terminal-watch-read", ref);
          if (!isCurrent()) return;
          if (update.status === "ended" || terminal.expiresAt <= Date.now()) {
            end();
            return;
          }
          if (update.status === "ready") {
            setView({ key, terminal: { ...terminal, output: update.output } });
          }
          watch.pollTimer = setTimeout(() => { void poll(); }, POLL_MS);
        } catch (error: unknown) {
          logFailure(error);
          end();
        }
      };

      setView({ key, terminal: { ...terminal, output } });
      watch.expiryTimer = setTimeout(end, lifetime);
      watch.pollTimer = setTimeout(() => { void poll(); }, POLL_MS);
    } catch (error: unknown) {
      logFailure(error);
      if (isCurrent()) {
        operation.current = null;
        void release(watch);
        setView({ key, status: START_STATUS.failed });
      }
    }
  }

  async function stop(ref: WatchRef) {
    const watch = operation.current;
    if (!key || activeScope.current !== key || watch?.ref?.watchId !== ref.watchId || watch.released) return;
    setView({ key, status: "Stopping Mac terminal watch…", busy: true });
    const result = await release(watch);
    if (operation.current !== watch) return;
    operation.current = null;
    const status = result?.ok ? "Mac terminal watch stopped."
      : result ? "Mac terminal watch already ended." : "The output was cleared. Matrix could not confirm Stop.";
    setView({ key, status });
  }

  const visible = key && view?.key === key ? view : null;
  const viewing = visible && "terminal" in visible ? visible.terminal : null;
  const waiting = visible && "status" in visible && visible.busy;
  const inUse = Boolean(viewing || waiting);
  const action: ComposerMentionAction | undefined = key && !inUse ? {
    label: "Watch an existing Mac terminal",
    kind: "terminal",
    keywords: "live output screen",
    consumeTrigger: true,
    select: () => { void start(); },
  } : undefined;
  const feedback = viewing && scope ? (
    <section aria-label="Mac terminal output" className="ph-no-capture mb-2 rounded-lg border border-[var(--border)] bg-[var(--bg-sunken)] text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate font-medium">{viewing.title}</p>
          <p className="text-xs text-[var(--text-secondary)]">Live output on this Mac</p>
        </div>
        <button type="button" className="rounded px-2 py-1 text-xs font-medium hover:bg-[var(--bg-hover)]"
          onClick={() => { void stop({ chatId: scope.chatId, worktreeId: scope.worktreeId, watchId: viewing.watchId }); }}>
          Stop watching
        </button>
      </div>
      {viewing.output ? (
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap break-all border-t border-[var(--border)] px-3 py-2 text-xs">
          {viewing.output}
        </pre>
      ) : <p className="px-3 pb-2 text-xs text-[var(--text-secondary)]">The terminal screen is empty.</p>}
    </section>
  ) : visible && "status" in visible ? (
    <p role="status" className="mb-2 px-1 text-xs text-[var(--text-secondary)]">{visible.status}</p>
  ) : null;
  return { action, feedback, inUse };
}
