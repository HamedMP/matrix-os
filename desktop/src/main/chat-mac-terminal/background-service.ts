import { randomUUID } from "node:crypto";
import type { InvokeResponse } from "../../shared/ipc-contract";
import type { PrepareMacTerminalCheck } from "../../shared/mac-terminal-probe-ipc";
import { MacTerminalDeliveryRejectedError, type MacTerminalContext, type MacTerminalRequest } from "../chat-electron-preview/transport";
import type { ChatTerminalProbe } from "../local-terminals/chat-terminal-probe";
import {
  MacTerminalProbeActionSchema, type MacTerminalProbeAction, type MacTerminalProbeOutput,
} from "../../shared/mac-terminal-probe";

type StartReply = InvokeResponse<"chat:mac-terminal-background-start">;
type StatusReply = InvokeResponse<"chat:mac-terminal-background-status">;
type Result = { terminalId: string; output: MacTerminalProbeOutput };
type DiscoveryGrant = { targetId: string; approvedAt: number };
type Event = "approved" | "dispatched" | "returned" | "failed" | "revoked";
type ResetReason = "expired" | "exhausted" | "authority-changed" | "stopped" | "unexpected-failure";
type FailureReason = "terminal-failed" | "terminal-cleanup-failed" | "delivery-expired" | "delivery-rejected"
  | "approval-failed" | "transport-failed";

interface Dependencies {
  enabled: boolean;
  oneTimeBusy(): boolean;
  approve(context: MacTerminalContext, signal: AbortSignal): Promise<boolean>;
  readTerminalContext(target: PrepareMacTerminalCheck, signal?: AbortSignal): Promise<MacTerminalContext | null>;
  isTerminalContextCurrent(context: MacTerminalContext): boolean;
  readBackgroundTerminalRequest(
    context: MacTerminalContext,
    grant: DiscoveryGrant,
    signal: AbortSignal,
  ): Promise<MacTerminalRequest | null>;
  tryBackgroundPreview?(
    context: MacTerminalContext, grant: DiscoveryGrant, signal: AbortSignal, beginPreview: () => boolean,
  ): Promise<void>;
  isTerminalRequestCurrent(request: MacTerminalRequest): boolean;
  returnTerminalResult(request: MacTerminalRequest, result: Result, signal: AbortSignal): Promise<void>;
  prepareTerminal(action: MacTerminalProbeAction): Promise<ChatTerminalProbe>;
  reportEvent(event: Event, reason?: ResetReason | FailureReason): void;
  onActiveChange(active: boolean): void;
}

interface Grant {
  context: MacTerminalContext;
  targetId: string;
  approvedAt: number;
  expiresAt: number;
  operation: AbortController;
  used: Set<string>;
  phase: "waiting" | "running" | "returning";
  transportFailureReported: boolean;
  expiryTimer: ReturnType<typeof setTimeout>;
  pollTimer?: ReturnType<typeof setTimeout>;
  displayTimer?: ReturnType<typeof setTimeout>;
  terminal?: ChatTerminalProbe;
  closingTerminal?: Promise<void>;
  pending?: { request: MacTerminalRequest; result: Result };
}

const CONSENT_MS = 60_000;
const GRANT_MS = 15 * 60_000;
const MAX_CHECKS = 3;
const POLL_MS = 3_000;
const RETRY_MS = 5_000;
const INSPECTION_MS = 30_000;

export function createMacTerminalBackgroundService(deps: Dependencies) {
  let preparing: { chatId: string; operation: AbortController } | null = null;
  let active: Grant | null = null;
  let inFlight: Promise<void> | null = null;
  let stopping: Promise<void> | null = null;

  const isBusy = () => Boolean(preparing || active || inFlight || stopping);
  const isLive = (grant: Grant) => active === grant && !grant.operation.signal.aborted && Date.now() < grant.expiresAt;
  const isCurrent = (grant: Grant) => isLive(grant) && deps.isTerminalContextCurrent(grant.context);

  function reportFailure(reason: FailureReason, error: unknown) {
    console.warn("[chat-mac-terminal-background]", reason, error instanceof Error ? "Error" : "NonError");
    deps.reportEvent("failed", reason);
  }

  async function dispose(terminal: ChatTerminalProbe) {
    try {
      await terminal.dispose();
    } catch (error: unknown) {
      reportFailure("terminal-cleanup-failed", error);
    }
  }

  async function closeTerminal(grant: Grant) {
    clearTimeout(grant.displayTimer);
    if (!grant.terminal) {
      await grant.closingTerminal;
      return;
    }
    const terminal = grant.terminal;
    grant.terminal = undefined;
    const closing = dispose(terminal);
    grant.closingTerminal = closing;
    try {
      await closing;
    } finally {
      if (grant.closingTerminal === closing) grant.closingTerminal = undefined;
    }
  }

  async function revoke(grant: Grant, reason: ResetReason) {
    if (active !== grant) return;
    active = null;
    clearTimeout(grant.expiryTimer);
    clearTimeout(grant.pollTimer);
    grant.pending = undefined;
    grant.operation.abort();
    const drain = closeTerminal(grant);
    stopping = drain;
    deps.onActiveChange(false);
    deps.reportEvent("revoked", reason);
    try {
      await drain;
    } finally {
      if (stopping === drain) stopping = null;
    }
  }

  function inspect(grant: Grant) {
    grant.displayTimer = setTimeout(() => {
      void closeTerminal(grant).then(() => {
        if (grant.used.size === MAX_CHECKS && !grant.pending) return revoke(grant, "exhausted");
      });
    }, INSPECTION_MS);
    grant.displayTimer.unref();
  }

  function matches(grant: Grant, request: MacTerminalRequest) {
    const { context } = grant;
    return request.chatId === context.chatId && request.worktreeId === context.worktreeId
      && request.projectId === context.projectId && request.scopeKey === context.scopeKey
      && request.targetId === grant.targetId && MacTerminalProbeActionSchema.safeParse(request.action).success
      && Date.now() < request.expiresAt && deps.isTerminalRequestCurrent(request);
  }

  function requestSignal(grant: Grant, request: MacTerminalRequest) {
    const deadline = Math.min(grant.expiresAt, request.expiresAt);
    return AbortSignal.any([grant.operation.signal, AbortSignal.timeout(Math.max(0, deadline - Date.now()))]);
  }

  async function deliver(grant: Grant) {
    const pending = grant.pending;
    if (!pending) return;
    if (!matches(grant, pending.request)) {
      grant.pending = undefined;
      grant.phase = "waiting";
      deps.reportEvent("failed", "delivery-expired");
      return;
    }
    // The canonical result writer reconciles a possibly committed receipt on
    // every attempt. Keep the request and output intact until delivery settles.
    let rejected = false;
    try {
      await deps.returnTerminalResult(pending.request, pending.result, requestSignal(grant, pending.request));
    } catch (error: unknown) {
      if (!(error instanceof MacTerminalDeliveryRejectedError)) throw error;
      rejected = true;
    }
    if (!isCurrent(grant)) return;
    grant.pending = undefined;
    grant.phase = "waiting";
    if (rejected) deps.reportEvent("failed", "delivery-rejected");
    else deps.reportEvent("returned");
  }

  async function dispatch(grant: Grant, request: MacTerminalRequest) {
    // Reserve this run synchronously before allocation or input. The set can
    // contain at most MAX_CHECKS elements for the session.
    grant.used.add(request.runId);
    grant.phase = "running";
    try {
      await closeTerminal(grant);
      if (!isCurrent(grant) || !matches(grant, request)) return;
      const terminal = await deps.prepareTerminal(request.action);
      if (!isCurrent(grant)) {
        await dispose(terminal);
        return;
      }
      grant.terminal = terminal;
      if (!matches(grant, request)) return;
      deps.reportEvent("dispatched");
      const output = await terminal.run(requestSignal(grant, request));
      if (!isCurrent(grant) || !matches(grant, request)) return;
      grant.pending = { request, result: { terminalId: terminal.id, output } };
      grant.phase = "returning";
      inspect(grant);
    } catch (error: unknown) {
      if (isCurrent(grant)) reportFailure("terminal-failed", error);
    } finally {
      if (!grant.pending) {
        grant.phase = "waiting";
        await closeTerminal(grant);
      }
    }
  }

  async function tick(grant: Grant) {
    if (!isCurrent(grant)) {
      await revoke(grant, Date.now() >= grant.expiresAt ? "expired" : "authority-changed");
      return;
    }
    if (!grant.pending && grant.used.size < MAX_CHECKS) {
      const discovery = { targetId: grant.targetId, approvedAt: grant.approvedAt };
      const { signal } = grant.operation;
      const request = await deps.readBackgroundTerminalRequest(grant.context, discovery, signal);
      if (!isCurrent(grant)) return;
      if (request && !grant.used.has(request.runId) && matches(grant, request)) {
        await dispatch(grant, request);
      } else if (!request && deps.tryBackgroundPreview) {
        try {
          await deps.tryBackgroundPreview(grant.context, discovery, signal, () => {
            if (!isCurrent(grant)) return false;
            // Keep this Chat free for the preview result once a target is found.
            grant.phase = "running";
            return true;
          });
        } finally {
          if (isCurrent(grant)) grant.phase = "waiting";
        }
      }
    }
    if (isCurrent(grant)) await deliver(grant);
  }

  function schedule(grant: Grant, delay: number) {
    grant.pollTimer = setTimeout(() => {
      let next = POLL_MS;
      const task = tick(grant).then(() => {
        grant.transportFailureReported = false;
      }).catch(async (error: unknown) => {
        if (!isLive(grant)) return;
        if (!(error instanceof Error)) {
          deps.reportEvent("failed", "transport-failed");
          await revoke(grant, "unexpected-failure");
          return;
        }
        // Discovery or delivery can recover on reconnection. The active grant
        // retains the same pending result, with time and memory bounded above.
        if (!grant.transportFailureReported) {
          grant.transportFailureReported = true;
          reportFailure("transport-failed", error);
        }
        next = RETRY_MS;
      }).finally(() => {
        if (inFlight === task) inFlight = null;
        if (active !== grant) return;
        if (!grant.pending && grant.used.size === MAX_CHECKS) {
          if (!grant.terminal) void revoke(grant, "exhausted");
          return;
        }
        schedule(grant, next);
      });
      inFlight = task;
    }, delay);
    grant.pollTimer.unref();
  }

  async function start(target: PrepareMacTerminalCheck): Promise<StartReply> {
    if (!deps.enabled) return { status: "unavailable" };
    if (isBusy() || deps.oneTimeBusy()) return { status: "busy" };
    const operation = new AbortController();
    preparing = { chatId: target.chatId, operation };
    try {
      const context = await deps.readTerminalContext(target, operation.signal);
      if (!context || context.chatId !== target.chatId || context.worktreeId !== target.worktreeId
        || operation.signal.aborted || !deps.isTerminalContextCurrent(context)) return { status: "unavailable" };
      const signal = AbortSignal.any([operation.signal, AbortSignal.timeout(CONSENT_MS)]);
      const approved = await deps.approve(context, signal);
      if (signal.aborted || !deps.isTerminalContextCurrent(context)) return { status: "unavailable" };
      if (!approved) return { status: "declined" };

      const approvedAt = Date.now();
      const grant: Grant = {
        context, approvedAt, expiresAt: approvedAt + GRANT_MS, operation, targetId: randomUUID(),
        used: new Set(), phase: "waiting", transportFailureReported: false,
        expiryTimer: setTimeout(() => { void revoke(grant, "expired"); }, GRANT_MS),
      };
      grant.expiryTimer.unref();
      active = grant;
      deps.onActiveChange(true);
      deps.reportEvent("approved");
      schedule(grant, 0);
      return { status: "ready", targetId: grant.targetId, expiresAt: grant.expiresAt, remaining: MAX_CHECKS };
    } catch (error: unknown) {
      if (operation.signal.aborted) return { status: "unavailable" };
      reportFailure("approval-failed", error);
      return { status: "failed" };
    } finally {
      preparing = null;
    }
  }

  function status(target: PrepareMacTerminalCheck): StatusReply {
    const grant = active;
    if (!grant || grant.context.chatId !== target.chatId || grant.context.worktreeId !== target.worktreeId
      || !isCurrent(grant)) return { active: false };
    return { active: true, targetId: grant.targetId, expiresAt: grant.expiresAt,
      remaining: MAX_CHECKS - grant.used.size, phase: grant.phase };
  }

  async function stop() {
    preparing?.operation.abort();
    const work = inFlight;
    if (active) await revoke(active, "stopped");
    await work;
  }

  async function cancel(chatId: string) {
    if (preparing?.chatId !== chatId && active?.context.chatId !== chatId) return false;
    await stop();
    return true;
  }

  return { start, status, isBusy, stop, cancel };
}
