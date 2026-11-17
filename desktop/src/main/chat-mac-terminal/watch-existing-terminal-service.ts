import { randomUUID } from "node:crypto";
import type { InvokeRequest, InvokeResponse } from "../../shared/ipc-contract";
import type { MacTerminalContext } from "../chat-electron-preview/transport";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { ExistingTerminalReader } from "../local-terminals/existing-terminal";
import type { BeginMacActivity, MacActivityHandle } from "../mac-activity/activity";

const APPROVAL_MS = 60_000;
const WATCH_MS = 5 * 60_000;
const SCREEN_READ_MS = 12_000;
const MIN_POLL_MS = 1_000;

type StartRequest = InvokeRequest<"chat:mac-terminal-watch-start">;
type StartReply = InvokeResponse<"chat:mac-terminal-watch-start">;
type WatchRef = InvokeRequest<"chat:mac-terminal-watch-read">;
type ReadReply = InvokeResponse<"chat:mac-terminal-watch-read">;
type EndReason = "revoked" | "stopped" | "expired" | "declined" | "failed";
type Terminal = ExistingTerminalReader["terminals"][number];

interface Dependencies {
  enabled: boolean;
  terminalBusy(): boolean;
  readTerminalContext(target: StartRequest, signal: AbortSignal): Promise<MacTerminalContext | null>;
  isTerminalContextCurrent(context: MacTerminalContext): boolean;
  openReader(): Promise<ExistingTerminalReader>;
  acquireActionPairing: MacActionPairing;
  beginActivity?: BeginMacActivity;
  reportError?(error: unknown): void;
}

interface NativeWatchApproval {
  sender: object;
  isCurrent(): boolean;
  pick(terminals: readonly Terminal[], signal: AbortSignal): Promise<string | null>;
  approve(context: MacTerminalContext, terminal: Terminal, signal: AbortSignal): Promise<boolean>;
  onClose(handler: () => void): () => void;
}

interface Watch {
  watchId: string;
  expiresAt: number;
  context: MacTerminalContext;
  reader: ExistingTerminalReader;
  terminal: Terminal;
  lease: MacActionPairingLease;
  nextReadAt: number;
}

interface Operation {
  target: StartRequest;
  native: NativeWatchApproval;
  controller: AbortController;
  pending?: Promise<unknown>;
  removeCloseListener?: () => void;
  expiry?: ReturnType<typeof setTimeout>;
  activity?: MacActivityHandle;
  lease?: MacActionPairingLease;
  watch?: Watch;
}

function endReason(reason: unknown): EndReason {
  switch (reason) {
    case "stopped":
    case "expired":
    case "declined":
    case "failed": return reason;
    default: return "revoked";
  }
}

export function createMacTerminalWatch(deps: Dependencies) {
  let active: Operation | null = null;

  function release(operation: Operation) {
    if (active !== operation || operation.pending || !operation.controller.signal.aborted) return;
    active = null;
    clearTimeout(operation.expiry);
    operation.removeCloseListener?.();
    operation.lease?.close();
    operation.activity?.finish(endReason(operation.controller.signal.reason));
  }

  function perform<T>(operation: Operation, callback: () => Promise<T>) {
    const result = Promise.resolve().then(callback).finally(() => {
      operation.pending = undefined;
      release(operation);
    });
    operation.pending = result;
    return result;
  }

  function setExpiry(operation: Operation, deadline: number) {
    clearTimeout(operation.expiry);
    operation.expiry = setTimeout(() => operation.controller.abort("expired"), Math.max(0, deadline - Date.now()));
    operation.expiry.unref();
  }

  function isCurrent(operation: Operation, context: MacTerminalContext, signal: AbortSignal) {
    return !signal.aborted && !operation.controller.signal.aborted
      && operation.native.isCurrent() && deps.isTerminalContextCurrent(context);
  }

  async function sameRegisteredChat(operation: Operation, context: MacTerminalContext, signal: AbortSignal) {
    if (!isCurrent(operation, context, signal)) return false;
    const latest = await deps.readTerminalContext(operation.target, signal);
    return isCurrent(operation, context, signal) && latest !== null
      && latest.chatId === context.chatId && latest.worktreeId === context.worktreeId
      && latest.projectId === context.projectId && latest.scopeKey === context.scopeKey;
  }

  async function readScreen(operation: Operation, watch: Watch) {
    const signal = AbortSignal.any([operation.controller.signal, AbortSignal.timeout(SCREEN_READ_MS)]);
    const { context, lease, reader, terminal } = watch;
    if (!isCurrent(operation, context, signal)) return null;
    const output = await reader.read(terminal.id, signal, { allowEmpty: true });
    if (!await sameRegisteredChat(operation, context, signal)) return null;
    await reader.assertCurrent(terminal.id, signal);
    if (!await lease.check(signal) || !isCurrent(operation, context, signal) || Date.now() >= watch.expiresAt) return null;
    reader.assertConnected();
    return output;
  }

  function endUnavailable(operation: Operation): { status: "unavailable" } {
    operation.controller.abort("revoked");
    return { status: "unavailable" };
  }

  async function prepare(operation: Operation): Promise<StartReply> {
    const { target, native, controller } = operation;
    const { signal } = controller;
    try {
      if (signal.aborted || !native.isCurrent()) return endUnavailable(operation);
      operation.removeCloseListener = native.onClose(() => controller.abort("revoked"));
      const context = await deps.readTerminalContext(target, signal);
      if (!context || context.chatId !== target.chatId || context.worktreeId !== target.worktreeId
        || !isCurrent(operation, context, signal)) return endUnavailable(operation);

      const reader = await deps.openReader();
      if (!reader.terminals.length || !isCurrent(operation, context, signal)) return endUnavailable(operation);
      operation.activity = deps.beginActivity?.("terminal-watch", context.worktreeId);
      operation.activity?.update("awaiting-approval");
      const selected = await native.pick(reader.terminals, signal);
      if (!isCurrent(operation, context, signal)) return endUnavailable(operation);
      if (!selected) {
        controller.abort("declined");
        return { status: "declined" };
      }

      const terminal = reader.terminals.find(item => item.id === selected);
      if (!terminal) return endUnavailable(operation);
      const approved = await native.approve(context, terminal, signal);
      if (!isCurrent(operation, context, signal)) return endUnavailable(operation);
      if (!approved) {
        controller.abort("declined");
        return { status: "declined" };
      }
      const expiresAt = Date.now() + WATCH_MS;
      setExpiry(operation, expiresAt);
      if (!await sameRegisteredChat(operation, context, signal)) return endUnavailable(operation);
      const lease = await deps.acquireActionPairing(controller, signal);
      operation.lease = lease ?? undefined;
      if (!lease || !await lease.check(signal) || !isCurrent(operation, context, signal)) return endUnavailable(operation);

      const watch: Watch = { watchId: randomUUID(), expiresAt, context, reader, terminal, lease, nextReadAt: 0 };
      const output = await readScreen(operation, watch);
      if (output === null || !isCurrent(operation, context, signal)) return endUnavailable(operation);
      operation.watch = watch;
      operation.activity?.update("running");
      return { status: "ready", watchId: watch.watchId, expiresAt, terminalId: terminal.id, title: terminal.title, output };
    } catch (error: unknown) {
      if (signal.aborted || !native.isCurrent()) return endUnavailable(operation);
      deps.reportError?.(error);
      controller.abort("failed");
      return { status: "failed" };
    }
  }

  function find(ref: WatchRef, sender: object) {
    const operation = active;
    if (operation?.watch?.watchId !== ref.watchId || operation.native.sender !== sender
      || operation.target.chatId !== ref.chatId || operation.target.worktreeId !== ref.worktreeId) return null;
    return operation;
  }

  async function cancel(operation: Operation, reason: EndReason) {
    operation.controller.abort(reason);
    await operation.pending;
    return true;
  }

  return {
    isBusy: () => active !== null,
    async start(target: StartRequest, native: NativeWatchApproval): Promise<StartReply> {
      if (!deps.enabled) return { status: "unavailable" };
      if (active || deps.terminalBusy()) return { status: "busy" };
      const operation: Operation = { target, native, controller: new AbortController() };
      active = operation;
      operation.controller.signal.addEventListener("abort", () => release(operation), { once: true });
      setExpiry(operation, Date.now() + APPROVAL_MS);
      return perform(operation, () => prepare(operation));
    },
    async read(ref: WatchRef, sender: object): Promise<ReadReply> {
      const operation = find(ref, sender);
      const watch = operation?.watch;
      if (!operation || !watch || operation.controller.signal.aborted) return { status: "ended" };
      if (!isCurrent(operation, watch.context, operation.controller.signal) || Date.now() >= watch.expiresAt) {
        operation.controller.abort(Date.now() >= watch.expiresAt ? "expired" : "revoked");
        return { status: "ended" };
      }
      if (operation.pending || Date.now() < watch.nextReadAt) return { status: "busy" };
      watch.nextReadAt = Date.now() + MIN_POLL_MS;
      return perform(operation, async () => {
        try {
          const output = await readScreen(operation, watch);
          if (output !== null && isCurrent(operation, watch.context, operation.controller.signal)) {
            return { status: "ready", output };
          }
          operation.controller.abort("revoked");
        } catch (error: unknown) {
          if (!operation.controller.signal.aborted) {
            deps.reportError?.(error);
            operation.controller.abort("failed");
          }
        }
        return { status: "ended" };
      });
    },
    async stop(ref: WatchRef, sender: object): Promise<{ ok: boolean }> {
      const operation = find(ref, sender);
      return { ok: operation ? await cancel(operation, "stopped") : false };
    },
    async cancel(reason: "revoked" | "stopped", chatId?: string) {
      const operation = active;
      if (!operation || (chatId !== undefined && chatId !== operation.target.chatId)) return false;
      return cancel(operation, reason);
    },
  };
}
