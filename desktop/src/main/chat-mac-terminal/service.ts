import { randomUUID } from "node:crypto";
import type { MacTerminalContext, MacTerminalRequest } from "../chat-electron-preview/transport";
import type { ChatTerminalProbe } from "../local-terminals/chat-terminal-probe";
import type { BeginMacActivity, MacActivityHandle, MacActivityPhase } from "../mac-activity/activity";
import type {
  PrepareMacTerminalCheck, PrepareMacTerminalCheckReply, RunMacTerminalCheck, RunMacTerminalCheckReply,
} from "../../shared/mac-terminal-probe-ipc";

interface Dependencies {
  enabled: boolean;
  readTerminalContext(target: PrepareMacTerminalCheck, signal?: AbortSignal): Promise<MacTerminalContext | null>;
  isTerminalContextCurrent(context: MacTerminalContext): boolean;
  readTerminalRequest(target: RunMacTerminalCheck, signal?: AbortSignal): Promise<MacTerminalRequest | null>;
  isTerminalRequestCurrent(request: MacTerminalRequest): boolean;
  returnTerminalResult(
    request: MacTerminalRequest, result: { terminalId: string; output: "Darwin" }, signal: AbortSignal,
  ): Promise<void>;
  approve(context: MacTerminalContext, signal: AbortSignal): Promise<boolean>;
  prepareTerminal(): Promise<ChatTerminalProbe>;
  beginActivity?: BeginMacActivity;
  reportError?(error: unknown): void;
}

type Cancellation = "stopped" | "revoked" | "expired";

function canceledPhase(signal: AbortSignal): Cancellation {
  if (signal.reason === "stopped") return "stopped";
  if (signal.reason === "expired" || signal.reason?.name === "TimeoutError") return "expired";
  return "revoked";
}

interface Grant {
  context: MacTerminalContext;
  targetId: string;
  terminal: ChatTerminalProbe;
  expiry: number;
  state: "ready" | "checking" | "used";
  operation: AbortController;
  activity?: MacActivityHandle;
  disposeTimer: ReturnType<typeof setTimeout>;
}

const CONSENT_WINDOW = 60_000;
const GRANT_WINDOW = 5 * 60_000;
const OUTPUT_INSPECTION_WINDOW = 30_000;

export function createChatMacTerminalService(deps: Dependencies) {
  let preparing: { chatId: string; operation: AbortController; result: Promise<PrepareMacTerminalCheckReply> } | null = null;
  let grant: Grant | null = null;
  let running: { chatId: string; result: Promise<RunMacTerminalCheckReply> } | null = null;
  let disposing: { chatId: string; result: Promise<void> } | null = null;
  const isBusy = () => Boolean(preparing || grant || running || disposing);

  async function disposeTerminal(current: Grant, reason: Cancellation): Promise<void> {
    try {
      await current.terminal.dispose();
    } catch (error: unknown) {
      deps.reportError?.(error);
    } finally {
      if (current.state !== "used") current.activity?.finish(reason);
    }
  }

  function release(current: Grant, reason: Cancellation): Promise<void> {
    if (grant !== current) return Promise.resolve();
    grant = null;
    clearTimeout(current.disposeTimer);
    current.operation.abort(reason);
    const result = disposeTerminal(current, reason).finally(() => { disposing = null; });
    disposing = { chatId: current.context.chatId, result };
    return result;
  }

  function scheduleRelease(current: Grant, window: number): void {
    clearTimeout(current.disposeTimer);
    current.disposeTimer = setTimeout(() => { void release(current, "expired"); }, window);
    current.disposeTimer.unref();
  }

  async function prepareGrant(target: PrepareMacTerminalCheck, operation: AbortController): Promise<PrepareMacTerminalCheckReply> {
    let activity: MacActivityHandle | undefined;
    let consent = operation.signal;
    let completion: MacActivityPhase = "failed";
    try {
      const context = await deps.readTerminalContext(target, operation.signal);
      if (!context || context.chatId !== target.chatId || context.worktreeId !== target.worktreeId
        || operation.signal.aborted || !deps.isTerminalContextCurrent(context)) return { status: "unavailable" };
      consent = AbortSignal.any([operation.signal, AbortSignal.timeout(CONSENT_WINDOW)]);
      activity = deps.beginActivity?.("terminal", context.worktreeId);
      activity?.update("awaiting-approval");
      const approved = await deps.approve(context, consent);
      if (consent.aborted || !deps.isTerminalContextCurrent(context)) {
        completion = "revoked";
        return { status: "unavailable" };
      }
      if (!approved) {
        completion = "declined";
        return { status: "declined" };
      }
      const terminal = await deps.prepareTerminal();
      if (consent.aborted || !deps.isTerminalContextCurrent(context)) {
        completion = "revoked";
        await terminal.dispose();
        return { status: "unavailable" };
      }
      const expiry = Date.now() + GRANT_WINDOW;
      const current: Grant = {
        context, terminal, expiry, targetId: randomUUID(), state: "ready", operation, activity,
        disposeTimer: setTimeout(() => { void release(current, "expired"); }, GRANT_WINDOW),
      };
      current.disposeTimer.unref();
      grant = current;
      activity?.update("ready");
      activity = undefined;
      return { status: "ready", targetId: current.targetId, terminalId: terminal.id, expiresAt: expiry };
    } catch (error: unknown) {
      if (consent.aborted) return { status: "unavailable" };
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      activity?.finish(consent.aborted ? canceledPhase(consent) : completion);
    }
  }

  async function prepare(target: PrepareMacTerminalCheck): Promise<PrepareMacTerminalCheckReply> {
    if (!deps.enabled) return { status: "unavailable" };
    if (isBusy()) return { status: "busy" };
    const operation = new AbortController();
    const result = prepareGrant(target, operation).finally(() => { preparing = null; });
    preparing = { chatId: target.chatId, operation, result };
    return result;
  }

  async function runCheck(current: Grant, target: RunMacTerminalCheck): Promise<RunMacTerminalCheckReply> {
    let { signal } = current.operation;
    let completion: MacActivityPhase = "failed";
    try {
      const request = await deps.readTerminalRequest(target, signal);
      const remaining = request ? Math.min(request.expiresAt, current.expiry) - Date.now() : 0;
      if (!request || grant !== current || signal.aborted || remaining <= 0
        || request.targetId !== current.targetId || request.action !== "uname"
        || request.chatId !== current.context.chatId || request.runId !== target.runId
        || request.projectId !== current.context.projectId || request.worktreeId !== current.context.worktreeId
        || request.scopeKey !== current.context.scopeKey || !deps.isTerminalContextCurrent(current.context)
        || !deps.isTerminalRequestCurrent(request)) return { status: "unavailable" };

      current.state = "used";
      signal = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      current.activity?.update("running");
      const output = await current.terminal.run(signal);
      if (output !== "Darwin") throw new Error("unexpected one-time Mac terminal output");
      if (grant !== current || signal.aborted || !deps.isTerminalRequestCurrent(request)
        || !deps.isTerminalContextCurrent(current.context)) {
        completion = "revoked";
        return { status: "unavailable" };
      }
      current.activity?.update("returning");
      await deps.returnTerminalResult(request, { terminalId: current.terminal.id, output }, signal);
      completion = "returned";
      return { status: "returned" };
    } catch (error: unknown) {
      if (signal.aborted) return { status: "unavailable" };
      deps.reportError?.(error);
      return { status: "failed" };
    } finally {
      if (current.state === "used") {
        current.activity?.finish(completion !== "returned" && signal.aborted ? canceledPhase(signal) : completion);
        current.activity = undefined;
      }
      if (grant === current && current.state === "checking") current.state = "ready";
      if (grant === current && current.state === "used") {
        scheduleRelease(current, Math.max(0, Math.min(OUTPUT_INSPECTION_WINDOW, current.expiry - Date.now())));
      }
    }
  }

  async function run(target: RunMacTerminalCheck): Promise<RunMacTerminalCheckReply> {
    const current = grant;
    if (!current || current.context.chatId !== target.chatId
      || !deps.isTerminalContextCurrent(current.context) || Date.now() >= current.expiry) return { status: "unavailable" };
    if (current.state === "used") return { status: "already-handled" };
    if (current.state === "checking" || running) return { status: "busy" };
    current.state = "checking";
    const result = runCheck(current, target).finally(() => { running = null; });
    running = { chatId: target.chatId, result };
    return result;
  }

  async function cancelScope(reason: Exclude<Cancellation, "expired">, chatId?: string): Promise<boolean> {
    const matches = (candidate: string) => chatId === undefined || chatId === candidate;
    const pending = preparing && matches(preparing.chatId) ? preparing : null;
    const current = grant && matches(grant.context.chatId) ? grant : null;
    const work = running && matches(running.chatId) ? running : null;
    const closing = disposing && matches(disposing.chatId) ? disposing : null;
    pending?.operation.abort(reason);
    await Promise.all([pending?.result, work?.result, current ? release(current, reason) : closing?.result]);
    return Boolean(pending || current || work || closing);
  }

  return {
    available: deps.enabled, prepare, run, isBusy,
    cancel: (chatId: string) => cancelScope("stopped", chatId),
    async cancelAll(reason: Exclude<Cancellation, "expired"> = "revoked") { await cancelScope(reason); },
  };
}
