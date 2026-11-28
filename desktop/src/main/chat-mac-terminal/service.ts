import { randomUUID } from "node:crypto";
import type { MacTerminalContext, MacTerminalRequest } from "../chat-electron-preview/transport";
import type { ChatTerminalProbe } from "../local-terminals/chat-terminal-probe";
import type {
  PrepareMacTerminalCheck, PrepareMacTerminalCheckReply, RunMacTerminalCheck, RunMacTerminalCheckReply,
} from "../../shared/mac-terminal-probe-ipc";

interface Dependencies {
  enabled: boolean;
  readTerminalContext(target: PrepareMacTerminalCheck): Promise<MacTerminalContext | null>;
  isTerminalContextCurrent(context: MacTerminalContext): boolean;
  readTerminalRequest(target: RunMacTerminalCheck): Promise<MacTerminalRequest | null>;
  isTerminalRequestCurrent(request: MacTerminalRequest): boolean;
  returnTerminalResult(
    request: MacTerminalRequest, result: { terminalId: string; output: "Darwin" }, signal: AbortSignal,
  ): Promise<void>;
  approve(context: MacTerminalContext, signal: AbortSignal): Promise<boolean>;
  prepareTerminal(): Promise<ChatTerminalProbe>;
  reportError?(error: unknown): void;
}

interface Grant {
  context: MacTerminalContext;
  targetId: string;
  terminal: ChatTerminalProbe;
  expiry: number;
  state: "ready" | "checking" | "used";
  operation: AbortController;
  disposeTimer: ReturnType<typeof setTimeout>;
}

const CONSENT_WINDOW = 60_000;
const GRANT_WINDOW = 5 * 60_000;
const OUTPUT_INSPECTION_WINDOW = 30_000;

export function createChatMacTerminalService(deps: Dependencies) {
  let preparing: { chatId: string; operation: AbortController } | null = null;
  let grant: Grant | null = null;
  let disposing = false;
  const isBusy = () => Boolean(preparing || grant || disposing);

  async function release(current: Grant): Promise<void> {
    if (grant !== current) return;
    grant = null;
    disposing = true;
    clearTimeout(current.disposeTimer);
    current.operation.abort();
    try {
      await current.terminal.dispose();
    } catch (error: unknown) {
      deps.reportError?.(error);
    } finally {
      disposing = false;
    }
  }

  function scheduleRelease(current: Grant, window: number): void {
    clearTimeout(current.disposeTimer);
    current.disposeTimer = setTimeout(() => { void release(current); }, window);
    current.disposeTimer.unref();
  }

  async function prepare(target: PrepareMacTerminalCheck): Promise<PrepareMacTerminalCheckReply> {
    if (!deps.enabled) return { status: "unavailable" };
    if (isBusy()) return { status: "busy" };
    const operation = new AbortController();
    preparing = { chatId: target.chatId, operation };
    try {
      const context = await deps.readTerminalContext(target);
      if (!context || context.chatId !== target.chatId || context.worktreeId !== target.worktreeId
        || operation.signal.aborted || !deps.isTerminalContextCurrent(context)) return { status: "unavailable" };
      const consent = AbortSignal.any([operation.signal, AbortSignal.timeout(CONSENT_WINDOW)]);
      const approved = await deps.approve(context, consent);
      if (consent.aborted || !deps.isTerminalContextCurrent(context)) return { status: "unavailable" };
      if (!approved) return { status: "declined" };
      const terminal = await deps.prepareTerminal();
      if (consent.aborted || !deps.isTerminalContextCurrent(context)) {
        await terminal.dispose();
        return { status: "unavailable" };
      }
      const expiry = Date.now() + GRANT_WINDOW;
      const current: Grant = {
        context, terminal, expiry, targetId: randomUUID(), state: "ready", operation,
        disposeTimer: setTimeout(() => { void release(current); }, GRANT_WINDOW),
      };
      current.disposeTimer.unref();
      grant = current;
      return { status: "ready", targetId: current.targetId, terminalId: terminal.id, expiresAt: expiry };
    } catch (error: unknown) {
      if (operation.signal.aborted) return { status: "unavailable" };
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      preparing = null;
    }
  }

  async function run(target: RunMacTerminalCheck): Promise<RunMacTerminalCheckReply> {
    const current = grant;
    if (!current || current.context.chatId !== target.chatId
      || !deps.isTerminalContextCurrent(current.context) || Date.now() >= current.expiry) return { status: "unavailable" };
    if (current.state === "used") return { status: "already-handled" };
    if (current.state === "checking") return { status: "busy" };
    current.state = "checking";
    const { signal } = current.operation;
    try {
      const request = await deps.readTerminalRequest(target);
      if (!request || grant !== current || signal.aborted || Date.now() >= Math.min(request.expiresAt, current.expiry)
        || request.targetId !== current.targetId || request.action !== "uname"
        || request.chatId !== current.context.chatId || request.runId !== target.runId
        || request.projectId !== current.context.projectId || request.worktreeId !== current.context.worktreeId
        || request.scopeKey !== current.context.scopeKey || !deps.isTerminalContextCurrent(current.context)
        || !deps.isTerminalRequestCurrent(request)) return { status: "unavailable" };

      current.state = "used";
      const output = await current.terminal.run(signal);
      if (output !== "Darwin") throw new Error("unexpected one-time Mac terminal output");
      if (grant !== current || signal.aborted || !deps.isTerminalRequestCurrent(request)
        || !deps.isTerminalContextCurrent(current.context)) return { status: "unavailable" };
      await deps.returnTerminalResult(request, { terminalId: current.terminal.id, output }, signal);
      return { status: "returned" };
    } catch (error: unknown) {
      if (signal.aborted) return { status: "unavailable" };
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      if (grant === current && current.state === "checking") current.state = "ready";
      if (grant === current && current.state === "used") {
        scheduleRelease(current, Math.max(0, Math.min(OUTPUT_INSPECTION_WINDOW, current.expiry - Date.now())));
      }
    }
  }

  async function cancel(chatId: string): Promise<boolean> {
    const pending = preparing?.chatId === chatId ? preparing : null;
    const current = grant?.context.chatId === chatId ? grant : null;
    pending?.operation.abort();
    if (current) await release(current);
    return pending !== null || current !== null;
  }

  async function cancelAll(): Promise<void> {
    preparing?.operation.abort();
    if (grant) await release(grant);
  }

  return { available: deps.enabled, prepare, run, cancel, cancelAll, isBusy };
}
