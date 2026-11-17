import type { InvokeResponse } from "../../shared/ipc-contract";
import type { PrepareMacTerminalCheck } from "../../shared/mac-terminal-probe-ipc";
import type { MacTerminalContext } from "../chat-electron-preview/transport";
import type { MacActionPairing, MacActionPairingLease } from "../desktop-pairing/action";
import type { LocalTerminalHost } from "../local-terminals/host";
import type { BeginMacActivity, MacActivityPhase } from "../mac-activity/activity";

const SNAPSHOT_WINDOW_MS = 60_000;
type SnapshotReply = InvokeResponse<"chat:mac-terminal-read-existing">;
type CancelReason = "revoked" | "stopped";
type TerminalReader = Awaited<ReturnType<LocalTerminalHost["openExistingTerminalReader"]>>;
type ListedTerminal = TerminalReader["terminals"][number];

interface Dependencies {
  enabled: boolean;
  terminalBusy(): boolean;
  readTerminalContext(target: PrepareMacTerminalCheck, signal: AbortSignal): Promise<MacTerminalContext | null>;
  isTerminalContextCurrent(context: MacTerminalContext): boolean;
  openReader(): Promise<TerminalReader>;
  acquireActionPairing: MacActionPairing;
  beginActivity?: BeginMacActivity;
  reportError?(error: unknown): void;
}

interface NativeSnapshotApproval {
  isCurrent(): boolean;
  pick(terminals: readonly ListedTerminal[], signal: AbortSignal): Promise<string | null>;
  approve(context: MacTerminalContext, terminal: ListedTerminal, output: string, signal: AbortSignal): Promise<boolean>;
}

export function createMacExistingTerminalService(deps: Dependencies) {
  let active: { chatId: string; operation: AbortController; result: Promise<SnapshotReply> } | null = null;

  async function capture(
    target: PrepareMacTerminalCheck, native: NativeSnapshotApproval, operation: AbortController,
  ): Promise<SnapshotReply> {
    const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(SNAPSHOT_WINDOW_MS)]);
    let activity: ReturnType<BeginMacActivity>;
    let lease: MacActionPairingLease | null = null;
    let phase: MacActivityPhase = "failed";
    try {
      if (!native.isCurrent()) return { status: "unavailable" };
      const context = await deps.readTerminalContext(target, signal);
      if (!context || context.chatId !== target.chatId || context.worktreeId !== target.worktreeId) {
        return { status: "unavailable" };
      }
      const isCurrent = () => !signal.aborted && native.isCurrent() && deps.isTerminalContextCurrent(context);
      const sameRegisteredChat = async () => {
        if (!isCurrent()) return false;
        const latest = await deps.readTerminalContext(target, signal);
        return isCurrent() && latest?.chatId === context.chatId && latest.projectId === context.projectId
          && latest.worktreeId === context.worktreeId && latest.scopeKey === context.scopeKey;
      };

      const reader = await deps.openReader();
      if (!reader.terminals.length || !isCurrent()) return { status: "unavailable" };
      activity = deps.beginActivity?.("terminal", context.worktreeId);
      activity?.update("awaiting-approval");
      const selected = await native.pick(reader.terminals, signal);
      if (!isCurrent()) {
        phase = "revoked";
        return { status: "unavailable" };
      }
      if (!selected) {
        phase = "declined";
        return { status: "declined" };
      }

      const terminal = reader.terminals.find(entry => entry.id === selected);
      phase = "revoked";
      if (!terminal || !await sameRegisteredChat()) return { status: "unavailable" };
      lease = await deps.acquireActionPairing(operation, signal);
      if (!lease || !await lease.check(signal) || !isCurrent()) return { status: "unavailable" };
      activity?.update("running");
      const output = await reader.read(terminal.id, signal);
      if (!isCurrent()) return { status: "unavailable" };
      activity?.update("awaiting-approval");
      const approved = await native.approve(context, terminal, output, signal);
      if (!isCurrent()) return { status: "unavailable" };
      if (!approved) {
        phase = "declined";
        return { status: "declined" };
      }
      if (!await sameRegisteredChat()) return { status: "unavailable" };
      await reader.assertCurrent(terminal.id, signal);
      if (!isCurrent() || !await lease.check(signal) || !isCurrent()) return { status: "unavailable" };
      phase = "returned";
      return { status: "ready", terminalId: terminal.id, title: terminal.title, output };
    } catch (error: unknown) {
      if (signal.aborted || !native.isCurrent()) {
        phase = "revoked";
        return { status: "unavailable" };
      }
      phase = "failed";
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      lease?.close();
      if (signal.aborted) {
        phase = signal.reason === "stopped" ? "stopped" : signal.reason?.name === "TimeoutError" ? "expired" : "revoked";
      }
      activity?.finish(phase);
    }
  }

  return {
    isBusy: () => active !== null,
    async run(target: PrepareMacTerminalCheck, native: NativeSnapshotApproval): Promise<SnapshotReply> {
      if (!deps.enabled) return { status: "unavailable" };
      if (active || deps.terminalBusy()) return { status: "busy" };
      const operation = new AbortController();
      const result = capture(target, native, operation).finally(() => { active = null; });
      active = { chatId: target.chatId, operation, result };
      return result;
    },
    async cancel(reason: CancelReason, chatId?: string) {
      const current = active;
      if (!current || (chatId !== undefined && current.chatId !== chatId)) return false;
      current.operation.abort(reason);
      await current.result;
      return true;
    },
  };
}
