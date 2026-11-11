import { setTimeout as delay } from "node:timers/promises";
import { TerminalRefSchema, type TerminalRef, type TerminalTab, type TerminalWorkspace } from "@matrix-os/contracts";
import { z } from "zod/v4";
import type { TerminalAgentRegistry, TerminalAgentRecord, TerminalFirstMessage } from "./registry.js";
import { MAX_TERMINAL_LABELS, TerminalLabelKeySchema, TerminalLabelValueSchema } from "./registry.js";
import type { TerminalAgentStatusSource } from "./status-source.js";
import { terminalRefKey } from "./status-source.js";
import type { TerminalTemplates } from "./templates.js";
import { TERMINAL_SEND_TEXT_MAX_CHARS, TerminalAgentVerbError, type TerminalAgentStatus, type TerminalAgentVerbs } from "./verbs.js";
import { TerminalWaitCapacityError } from "./wait.js";

const READY_TIMEOUT_MS = 60_000;
// Child waits each poll the registry and runtime; bound them like single-tab waits.
const MAX_CHILD_WAITS = 64;
const MAX_CHILD_WAITS_PER_PARENT = 4;
const READY_POLL_MS = 500;
const SCREEN_SETTLE_MS = 3_000;
const MAX_FIRST_MESSAGE_CHARS = TERMINAL_SEND_TEXT_MAX_CHARS;
// Room the `<matrix from=…>` envelope needs around a report.
const ENVELOPE_RESERVE_CHARS = 256;
/** The longest report a child may send, so the enveloped text still fits one send. */
export const TERMINAL_REPORT_MAX_CHARS = TERMINAL_SEND_TEXT_MAX_CHARS - ENVELOPE_RESERVE_CHARS;
// As for single-tab waits: after a send, older reports describe the previous turn.
const SEND_TURN_GRACE_MS = 15_000;
// A record this young may belong to a tab created after the pass listed tabs.
const PRUNE_GRACE_MS = 60_000;

export interface TerminalAgentRuntime {
  listWorkspaces(): Promise<TerminalWorkspace[]>;
  ensureWorkspace(input?: { projectId?: string }): Promise<TerminalWorkspace>;
  createTab(workspaceId: string, input: { name: string; cwd: string; command?: string[]; accessScope?: TerminalTab["accessScope"] }): Promise<TerminalTab>;
  terminateTab(ref: TerminalRef, expectedIncarnation?: string): Promise<void>;
  getSnapshot(ref: TerminalRef): Promise<unknown>;
  resolvePane?(input: { sessionName: string; paneId: string }): Promise<TerminalRef | null>;
}

export const TerminalCallerSchema = z.object({
  // zellij's own name for the caller's session: logical, or physical on customer VPSes.
  sessionName: z.string().regex(/^matrix-(?:w-|rt_)[0-9a-f]{32}$/),
  paneId: z.string().regex(/^[0-9]{1,9}$/),
}).strict();
export type TerminalCaller = z.infer<typeof TerminalCallerSchema>;

export const TerminalLabelsSchema = z.record(TerminalLabelKeySchema, TerminalLabelValueSchema)
  .refine((labels) => Object.keys(labels).length <= MAX_TERMINAL_LABELS, { message: "Too many labels" });

export interface TerminalRunInput {
  projectId?: string;
  name: string;
  cwd: string;
  argv?: string[];
  template?: string;
  task?: string;
  parent?: TerminalRef;
  caller?: TerminalCaller;
  noParent?: boolean;
  outliveParent?: boolean;
  labels?: Record<string, string>;
  /** Longest wait for the agent to be ready for its task (1 to 60 s; default 60 s). */
  readyTimeoutMs?: number;
}

export interface TerminalRunResult {
  ref: TerminalRef;
  tab: TerminalTab;
  parent?: TerminalRef;
  firstMessage?: TerminalFirstMessage;
}

export type TerminalChildrenWaitResult =
  | { reason: "changed"; child: TerminalRef; status?: TerminalAgentStatus; exited?: boolean }
  | { reason: "idle" }
  | { reason: "none" }
  | { reason: "timeout" };

function sanitizeTag(value: string): string {
  return value.replace(/[^A-Za-z0-9 _.:-]/g, "").slice(0, 80);
}

/** Herdr's `<hc from="t7 review">…</hc>` envelope, in Matrix's own tag. */
export function terminalAgentEnvelope(from: { tabId: string; name: string }, text: string, reach?: string): string {
  const reachAttribute = reach ? ` reach="${sanitizeTag(reach)}"` : "";
  return `<matrix from="${sanitizeTag(`${from.tabId} ${from.name}`)}"${reachAttribute}>${text}</matrix>`;
}

/**
 * Agents in terminals, Herdr style: start one from a command or template with a
 * first task, remember its parent and labels, let children report back, and
 * wait for children. Tab lifecycles stay in the terminal runtime.
 */
export function createTerminalAgents(options: {
  runtime: TerminalAgentRuntime;
  verbs: TerminalAgentVerbs;
  status: TerminalAgentStatusSource;
  registry: TerminalAgentRegistry;
  templates: TerminalTemplates;
  /** Project admission for writes into an existing workspace (collaboration fences). */
  admitWorkspace?: <T>(workspaceId: string, operation: () => Promise<T>) => Promise<T>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}) {
  const now = options.now ?? Date.now;
  const admitWorkspace = options.admitWorkspace ?? (<T>(_workspaceId: string, operation: () => Promise<T>) => operation());
  const sleep = options.sleep ?? ((ms: number) => delay(ms).then(() => undefined));

  async function findTab(ref: TerminalRef): Promise<TerminalTab | undefined> {
    const workspace = (await options.runtime.listWorkspaces()).find((candidate) => candidate.id === ref.workspaceId);
    const tab = workspace?.tabs.find((candidate) => candidate.id === ref.tabId);
    return tab?.accessScope === "owner" ? tab : undefined;
  }

  async function resolveCaller(caller: TerminalCaller | undefined): Promise<TerminalRef | undefined> {
    if (!caller || !options.runtime.resolvePane) return undefined;
    const ref = await options.runtime.resolvePane(caller);
    return ref && await findTab(ref) ? ref : undefined;
  }

  async function screenText(ref: TerminalRef): Promise<string> {
    const parsed = z.object({ viewport: z.array(z.string()).max(200) }).safeParse(await options.runtime.getSnapshot(ref));
    return parsed.success ? parsed.data.viewport.join("\n") : "";
  }

  /** Wait until a just-started agent can take input, then send its first message once. */
  async function deliverFirstMessage(ref: TerminalRef, text: string, readyTimeoutMs: number): Promise<TerminalFirstMessage> {
    const started = now();
    let screen = await screenText(ref);
    let screenSince = now();
    while (now() - started < readyTimeoutMs) {
      const tab = await findTab(ref);
      if (!tab || tab.status === "exited" || tab.status === "failed") return { sent: false, reason: "finished" };
      const status = (await options.status.get(ref))?.status;
      if (status === "blocked") return { sent: false, reason: "blocked" };
      const current = await screenText(ref);
      if (current !== screen) {
        screen = current;
        screenSince = now();
      }
      const settled = current.trim() !== "" && now() - screenSince >= SCREEN_SETTLE_MS;
      if (status === "idle" || status === "done" || (status === undefined && settled)) {
        try {
          await options.verbs.send(ref, { text });
          return { sent: true };
        } catch (error: unknown) {
          if (error instanceof TerminalAgentVerbError) {
            return { sent: false, reason: error.code === "blocked" ? "blocked" : error.code === "finished" ? "finished" : "failed" };
          }
          console.warn("[gateway] terminal first message failed", error instanceof Error ? error.name : "unknown_error");
          // It may still have arrived: record a failure, never resend blindly.
          return { sent: false, reason: "failed" };
        }
      }
      await sleep(READY_POLL_MS);
    }
    return { sent: false, reason: "not_ready" };
  }

  // Child waits in progress: bounded, released when each wait ends.
  const childWaits = new Map<string, number>();
  let childWaitTotal = 0;

  async function waitForChildren(parent: TerminalRef, input: { mode: "any" | "all"; timeoutMs: number; signal?: AbortSignal }): Promise<TerminalChildrenWaitResult> {
    const deadline = now() + input.timeoutMs;
    const snapshot = async () => {
      const children = await options.registry.children(parent);
      const statuses = await options.status.list();
      const facts = new Map<string, { ref: TerminalRef; status?: TerminalAgentStatus; live: boolean }>();
      for (const child of children) {
        const tab = await findTab(child.ref);
        const live = Boolean(tab && tab.status !== "exited" && tab.status !== "failed");
        const entry = statuses.get(terminalRefKey(child.ref));
        // A report older than the child's latest task belongs to the previous turn.
        const sentAt = options.status.sentAt?.(child.ref);
        const previousTurn = entry !== undefined && sentAt !== undefined
          && Date.parse(entry.reportedAt) < sentAt && now() - sentAt < SEND_TURN_GRACE_MS;
        const status = previousTurn ? "working" : entry?.status;
        facts.set(terminalRefKey(child.ref), { ref: child.ref, live, ...(status ? { status } : {}) });
      }
      return facts;
    };
    const initial = await snapshot();
    if (initial.size === 0) return { reason: "none" };
    for (;;) {
      if (input.signal?.aborted) return { reason: "timeout" };
      const current = await snapshot();
      if (input.mode === "all") {
        // A child without status counts as working until it exits.
        const working = [...current.values()].some((child) => child.live && (child.status === undefined || child.status === "working"));
        if (!working) return { reason: "idle" };
      } else {
        for (const [key, before] of initial) {
          const child = current.get(key);
          // A child whose record is gone was removed: that is its exit.
          if (!child) return { reason: "changed", child: before.ref, exited: true };
          if (before.live && !child.live) return { reason: "changed", child: child.ref, exited: true };
          if (child.status !== before.status && child.status !== "working") {
            return { reason: "changed", child: child.ref, ...(child.status ? { status: child.status } : {}) };
          }
        }
      }
      if (now() >= deadline) return { reason: "timeout" };
      await sleep(Math.min(READY_POLL_MS * 2, Math.max(1, deadline - now())));
    }
  }

  return {
    async run(input: TerminalRunInput): Promise<TerminalRunResult> {
      const template = input.template ? await options.templates.get(input.template) : undefined;
      if (input.template && !template) throw new TerminalAgentVerbError("not_found");
      if (input.template && input.argv) throw new TerminalAgentVerbError("invalid_request");
      let parent: TerminalRef | undefined;
      if (!input.noParent) {
        if (input.parent) {
          if (!await findTab(input.parent)) throw new TerminalAgentVerbError("not_found");
          parent = TerminalRefSchema.parse(input.parent);
        } else {
          parent = await resolveCaller(input.caller);
        }
      }
      const parentTab = parent ? await findTab(parent) : undefined;
      // Build and bound the first message before anything is started: a task that
      // does not fit is refused instead of being cut short.
      const task = [template?.body, input.task].filter((part): part is string => Boolean(part?.trim())).join("\n\n");
      const wrapped = task && parent && parentTab
        ? terminalAgentEnvelope({ tabId: parent.tabId, name: parentTab.name }, task, "matrix shell report when done or stuck")
        : task;
      if (wrapped.length > MAX_FIRST_MESSAGE_CHARS) throw new TerminalAgentVerbError("invalid_request");
      const workspace = await options.runtime.ensureWorkspace(input.projectId ? { projectId: input.projectId } : {});
      const command = template ? ["sh", "-lc", template.command] : input.argv;
      const tab = await options.runtime.createTab(workspace.id, {
        name: input.name,
        cwd: input.cwd,
        accessScope: "owner",
        ...(command ? { command } : {}),
      });
      const ref = { workspaceId: workspace.id, tabId: tab.id };
      await options.registry.upsert(ref, (current) => ({
        ...current,
        ...(tab.incarnation ? { incarnation: tab.incarnation } : {}),
        labels: { ...current.labels, ...input.labels },
        ...(parent ? { parent } : {}),
        outliveParent: input.outliveParent === true,
        ...(template ? { template: template.name } : {}),
      }));
      if (!wrapped) return { ref, tab, ...(parent ? { parent } : {}) };
      // A caller with its own request deadline (hosted MCP) shortens the readiness wait.
      const readyTimeoutMs = Math.min(READY_TIMEOUT_MS, Math.max(1_000, input.readyTimeoutMs ?? READY_TIMEOUT_MS));
      const firstMessage = await deliverFirstMessage(ref, wrapped, readyTimeoutMs);
      await options.registry.upsert(ref, (current) => ({ ...current, firstMessage }));
      return { ref, tab, ...(parent ? { parent } : {}), firstMessage };
    },

    async describe(ref: TerminalRef): Promise<TerminalAgentRecord | undefined> {
      return options.registry.get(ref);
    },

    async label(ref: TerminalRef, input: { set?: Record<string, string>; remove?: string[] }): Promise<TerminalAgentRecord> {
      if (!await findTab(ref)) throw new TerminalAgentVerbError("not_found");
      const set = TerminalLabelsSchema.parse(input.set ?? {});
      const remove = z.array(TerminalLabelKeySchema).max(MAX_TERMINAL_LABELS).parse(input.remove ?? []);
      return options.registry.upsert(ref, (current) => {
        const labels = { ...current.labels, ...set };
        for (const key of remove) delete labels[key];
        return { ...current, labels };
      });
    },

    /** Send a child's report to the parent that started it, tagged with the child. */
    async reportToParent(input: { caller: TerminalCaller; text: string }): Promise<{ sent: true; parent: TerminalRef }> {
      if (input.text.length > TERMINAL_REPORT_MAX_CHARS) throw new TerminalAgentVerbError("invalid_request");
      const child = await resolveCaller(input.caller);
      if (!child) throw new TerminalAgentVerbError("not_found");
      const record = await options.registry.get(child);
      const childTab = await findTab(child);
      if (!record?.parent || !childTab) throw new TerminalAgentVerbError("not_found");
      const parent = record.parent;
      await admitWorkspace(parent.workspaceId, () => options.verbs.send(parent, {
        text: terminalAgentEnvelope({ tabId: child.tabId, name: childTab.name }, input.text),
      }));
      return { sent: true, parent };
    },

    async resolveCaller(caller: TerminalCaller): Promise<TerminalRef | undefined> {
      return resolveCaller(caller);
    },

    /** Herdr's `wait --children any|all` for one parent. */
    waitChildren(parent: TerminalRef, input: { mode: "any" | "all"; timeoutMs: number; signal?: AbortSignal }): Promise<TerminalChildrenWaitResult> {
      const key = terminalRefKey(parent);
      const forParent = childWaits.get(key) ?? 0;
      if (childWaitTotal >= MAX_CHILD_WAITS || forParent >= MAX_CHILD_WAITS_PER_PARENT) {
        return Promise.reject(new TerminalWaitCapacityError());
      }
      childWaitTotal += 1;
      childWaits.set(key, forParent + 1);
      return waitForChildren(parent, input).finally(() => {
        childWaitTotal -= 1;
        const left = (childWaits.get(key) ?? 1) - 1;
        if (left <= 0) childWaits.delete(key);
        else childWaits.set(key, left);
      });
    },


    /**
     * One supervision pass: end children whose parent ended (unless they outlive it),
     * note blocked/errored/exited children to their parent, and prune dead records.
     */
    async supervise(state: Map<string, string>): Promise<void> {
      const tabKeys = async () => {
        const live = new Map<string, TerminalTab>();
        const all = new Set<string>();
        for (const workspace of await options.runtime.listWorkspaces()) {
          for (const tab of workspace.tabs) {
            const key = terminalRefKey({ workspaceId: workspace.id, tabId: tab.id });
            all.add(key);
            if (tab.status !== "exited" && tab.status !== "failed") live.set(key, tab);
          }
        }
        return { live, all };
      };
      const { live, all } = await tabKeys();
      const records = await options.registry.list();
      const statuses = await options.status.list();
      // Records kept even though their tab is gone: a note to the parent is still owed.
      const pending = new Set<string>();
      const note = async (record: TerminalAgentRecord, key: string, name: string, text: string) => {
        const parent = record.parent!;
        try {
          await admitWorkspace(parent.workspaceId, () => options.verbs.send(parent, {
            text: terminalAgentEnvelope({ tabId: record.ref.tabId, name }, text),
          }));
          return true;
        } catch (error: unknown) {
          // A blocked, busy or fenced parent keeps the note pending for the next pass.
          if (!(error instanceof TerminalAgentVerbError)) {
            console.warn("[gateway] terminal parent note failed", error instanceof Error ? error.name : "unknown_error");
          }
          state.delete(key);
          return false;
        }
      };
      for (const record of records) {
        if (!record.parent) continue;
        const key = terminalRefKey(record.ref);
        const childTab = live.get(key);
        const parentKey = terminalRefKey(record.parent);
        if (!live.has(parentKey)) {
          if (childTab && !record.outliveParent) {
            await admitWorkspace(record.ref.workspaceId, () => options.runtime.terminateTab(record.ref, record.incarnation))
              .catch((error: unknown) => {
                console.warn("[gateway] terminal child cleanup failed", error instanceof Error ? error.name : "unknown_error");
              });
          }
          continue;
        }
        const word = !all.has(key) ? "removed" : childTab ? statuses.get(key)?.status : "exited";
        const previous = state.get(key);
        if (word) state.set(key, word);
        if (!word || word === previous) continue;
        // A removed child that already reported its exit needs no second note.
        if (word === "removed" && previous === "exited") continue;
        if (word !== "blocked" && word !== "error" && word !== "exited" && word !== "removed") continue;
        const name = childTab?.name ?? record.ref.tabId;
        const text = word === "exited" || word === "removed" ? "exited"
          : word === "blocked" ? "is blocked and needs a person; read its screen" : "reported an error; read its screen";
        if (!await note(record, key, name, text) && word === "removed") pending.add(key);
      }
      // List again right before pruning: a tab created during this pass keeps its record,
      // and so does any record younger than the grace period.
      const fresh = await tabKeys();
      const keep = new Set([...all, ...fresh.all, ...pending]);
      const cutoff = now() - PRUNE_GRACE_MS;
      for (const record of await options.registry.list()) {
        if (Date.parse(record.createdAt) > cutoff) keep.add(terminalRefKey(record.ref));
      }
      for (const key of state.keys()) if (!keep.has(key)) state.delete(key);
      await options.registry.prune(keep);
    },
  };
}

export type TerminalAgents = ReturnType<typeof createTerminalAgents>;
