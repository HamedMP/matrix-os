/**
 * The Mail agent panel's state and actions, framework-free.
 *
 *   const agent = createMailAgent(createMailAgentContext({ ai, store, providerFor }));
 *   const state = useSyncExternalStore(agent.subscribe, agent.getState);
 *
 * One task runs at a time; `cancel()` stops it. Results are reviewable items:
 * draft proposals (keep or discard), summaries, ranked search results and
 * triage suggestion lists the owner applies with one click. Nothing sends.
 */
import { localId, type ThreadKey } from "../model/ids";
import { MAIL_AGENT_ERROR_MESSAGES, MailAgentError, agentErrorMessage, toMailAgentError, type AgentLogger } from "./errors";
import { createBulkDrafts, type BulkDrafts } from "./bulk";
import type { MailAgentContext } from "./context";
import { requireAccount } from "./context";
import { discardProposal, draftNew, draftReply, keepProposal } from "./drafting";
import { routeIntent, type MailIntentKind } from "./intent";
import { MAX_PANEL_MESSAGES, MAX_PANEL_RESULTS, MAX_PANEL_STATUS_LINES } from "./limits";
import { agenticSearch, openSearchResult, type AgenticSearchResult, type RankedThread } from "./search";
import { summarizeThread, type ThreadDigest } from "./summarize";
import { applyTriageSuggestions, suggestTriage, type TriageApplyResult, type TriageSuggestion } from "./triage";
import { oneLineText } from "./untrusted";
import { loadVoiceProfile } from "./voice";

export interface PanelMessage {
  id: string;
  role: "user" | "agent";
  text: string;
}

export interface PanelStatusLine {
  id: string;
  text: string;
  state: "pending" | "running" | "done" | "error";
}

export type PanelItem =
  | { kind: "draft"; id: string; proposalId: string }
  | { kind: "summary"; id: string; digest: ThreadDigest }
  | { kind: "search"; id: string; question: string; result: AgenticSearchResult }
  | { kind: "triage"; id: string; suggestions: TriageSuggestion[]; status: "proposed" | "applying" | "applied" | "dismissed"; outcome: TriageApplyResult | null };

export interface MailAgentState {
  busy: boolean;
  task: MailIntentKind | null;
  messages: PanelMessage[];
  status: PanelStatusLine[];
  /** Newest first. */
  items: PanelItem[];
  /** The last failure, an allowlisted sentence. */
  error: string | null;
}

export interface MailAgent {
  subscribe(listener: () => void): () => void;
  getState(): MailAgentState;
  context: MailAgentContext;
  /** Routes free text to a feature. */
  ask(text: string): Promise<void>;
  draftReply(instruction?: string, key?: ThreadKey): Promise<void>;
  draftNew(instruction: string): Promise<void>;
  summarize(key?: ThreadKey): Promise<void>;
  search(question: string): Promise<void>;
  suggestTriage(keys?: ThreadKey[], instruction?: string): Promise<void>;
  toggleTriage(itemId: string, suggestionId: string, selected: boolean): void;
  applyTriage(itemId: string): Promise<void>;
  dismissTriage(itemId: string): void;
  keepDraft(proposalId: string): void;
  discardDraft(proposalId: string): Promise<void>;
  openResult(result: RankedThread): Promise<void>;
  cancel(): void;
  clearError(): void;
  /** A bulk drafts session for an account, with the owner's overall voice loaded. */
  createBulk(accountId?: string): Promise<BulkDrafts>;
}

const STATUS_TEXT: Record<MailIntentKind, string> = {
  reply: "Drafting a reply",
  new: "Drafting a new message",
  summarize: "Summarising the conversation",
  search: "Searching your mail",
  triage: "Looking at the selected conversations",
};

const MAX_ECHO_CHARS = 500;

export function createMailAgent(ctx: MailAgentContext): MailAgent {
  let state: MailAgentState = { busy: false, task: null, messages: [], status: [], items: [], error: null };
  let controller: AbortController | null = null;
  const listeners: Array<() => void> = [];
  const log: AgentLogger = ctx.log;

  const set = (update: (s: MailAgentState) => MailAgentState) => {
    const next = update(state);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };
  const addItem = (item: PanelItem) => set((s) => ({ ...s, items: [item, ...s.items].slice(0, MAX_PANEL_RESULTS) }));
  const addMessage = (role: PanelMessage["role"], text: string) =>
    set((s) => ({ ...s, messages: [...s.messages, { id: localId("msg"), role, text: oneLineText(text, MAX_ECHO_CHARS) }].slice(-MAX_PANEL_MESSAGES) }));
  const addStatus = (text: string, lineState: PanelStatusLine["state"] = "running") => {
    const id = localId("status");
    set((s) => ({ ...s, status: [...s.status.map((l) => (l.state === "running" ? { ...l, state: "done" as const } : l)), { id, text, state: lineState }].slice(-MAX_PANEL_STATUS_LINES) }));
    return id;
  };
  const finishStatus = (lineState: "done" | "error") =>
    set((s) => ({ ...s, status: s.status.map((l) => (l.state === "running" ? { ...l, state: lineState } : l)) }));

  const openKey = () => ctx.store.getSnapshot().openThread?.key ?? null;

  /** Runs one task with busy state, cancellation and allowlisted errors. */
  async function run(task: MailIntentKind, body: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (state.busy) return;
    const local = new AbortController();
    controller = local;
    set((s) => ({ ...s, busy: true, task, error: null, status: [] }));
    addStatus(STATUS_TEXT[task]);
    try {
      await body(local.signal);
      finishStatus("done");
    } catch (error: unknown) {
      const agentError = toMailAgentError(error);
      if (agentError.code !== "cancelled") log("agent.task.failed", error);
      finishStatus("error");
      set((s) => ({ ...s, error: agentErrorMessage(agentError) }));
    } finally {
      if (controller === local) controller = null;
      set((s) => ({ ...s, busy: false, task: null }));
    }
  }

  const agent: MailAgent = {
    subscribe(listener) {
      if (listeners.length >= 50) throw new RangeError("Too many agent listeners");
      listeners.push(listener);
      return () => {
        const i = listeners.indexOf(listener);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    getState: () => state,
    context: ctx,

    async ask(text) {
      const trimmed = text.trim();
      if (!trimmed || state.busy) return;
      addMessage("user", trimmed);
      const snapshot = ctx.store.getSnapshot();
      const intent = routeIntent(trimmed, { hasThread: Boolean(snapshot.openThread), hasSelection: snapshot.selection.keys.length > 0 });
      if (intent.kind === "reply") return agent.draftReply(intent.text);
      if (intent.kind === "new") return agent.draftNew(intent.text);
      if (intent.kind === "summarize") return agent.summarize();
      if (intent.kind === "triage") return agent.suggestTriage(undefined, intent.text);
      return agent.search(intent.text);
    },

    draftReply: (instruction = "", key) => run("reply", async (signal) => {
      const target = key ?? openKey();
      if (!target) throw new MailAgentError("no_thread");
      const proposal = await draftReply(ctx, target, instruction, { signal });
      addItem({ kind: "draft", id: localId("item"), proposalId: proposal.id });
      addMessage("agent", proposal.saveFailed ? "The draft is open in the composer for your review. It is not saved to your mailbox yet." : "The draft is open in the composer and saved to your drafts. Review it before sending.");
    }),

    draftNew: (instruction) => run("new", async (signal) => {
      const proposal = await draftNew(ctx, instruction, { signal });
      addItem({ kind: "draft", id: localId("item"), proposalId: proposal.id });
      addMessage("agent", "The new draft is open in the composer. Check the recipients before sending.");
    }),

    summarize: (key) => run("summarize", async (signal) => {
      const target = key ?? openKey();
      if (!target) throw new MailAgentError("no_thread");
      const digest = await summarizeThread(ctx, target, { signal });
      addItem({ kind: "summary", id: localId("item"), digest });
    }),

    search: (question) => run("search", async (signal) => {
      const result = await agenticSearch(ctx, question, { signal, onProgress: (text) => addStatus(text) });
      addItem({ kind: "search", id: localId("item"), question: oneLineText(question, 200), result });
      if (!result.results.length) addMessage("agent", "No matching conversations were found. Try naming a person, a rough date or a document.");
    }),

    suggestTriage: (keys, instruction) => run("triage", async (signal) => {
      const snapshot = ctx.store.getSnapshot();
      const targets = keys ?? (snapshot.selection.keys.length ? snapshot.selection.keys : openKey() ? [openKey()!] : []);
      const suggestions = await suggestTriage(ctx, targets, { signal, instruction });
      addItem({ kind: "triage", id: localId("item"), suggestions, status: "proposed", outcome: null });
      if (!suggestions.length) addMessage("agent", "Nothing to change for these conversations.");
    }),

    toggleTriage(itemId, suggestionId, selected) {
      set((s) => ({
        ...s,
        items: s.items.map((item) => (item.kind === "triage" && item.id === itemId && item.status === "proposed"
          ? { ...item, suggestions: item.suggestions.map((sg) => (sg.id === suggestionId ? { ...sg, selected } : sg)) }
          : item)),
      }));
    },

    async applyTriage(itemId) {
      const item = state.items.find((entry) => entry.id === itemId);
      if (!item || item.kind !== "triage" || item.status !== "proposed") return;
      const patch = (p: Partial<Extract<PanelItem, { kind: "triage" }>>) =>
        set((s) => ({ ...s, items: s.items.map((entry) => (entry.id === itemId && entry.kind === "triage" ? { ...entry, ...p } : entry)) }));
      patch({ status: "applying" });
      const outcome = await applyTriageSuggestions(ctx.store, item.suggestions);
      patch({ status: "applied", outcome });
    },

    dismissTriage(itemId) {
      set((s) => ({ ...s, items: s.items.map((entry) => (entry.id === itemId && entry.kind === "triage" && entry.status === "proposed" ? { ...entry, status: "dismissed" } : entry)) }));
    },

    keepDraft: (proposalId) => keepProposal(ctx, proposalId),
    discardDraft: (proposalId) => discardProposal(ctx, proposalId),

    async openResult(result) {
      const opened = await openSearchResult(ctx.store, result);
      if (!opened) set((s) => ({ ...s, error: MAIL_AGENT_ERROR_MESSAGES.thread_unavailable }));
    },

    cancel() {
      controller?.abort();
    },

    clearError: () => set((s) => (s.error ? { ...s, error: null } : s)),

    async createBulk(accountId) {
      const { account, provider } = requireAccount(ctx, accountId);
      const voice = await loadVoiceProfile({
        account, provider, recipient: null, folders: ctx.store.getSnapshot().folders[account.id] ?? [], cache: ctx.voiceCache, now: ctx.now, logger: log,
      });
      return createBulkDrafts({ ai: ctx.ai, account, provider, voice, logger: log });
    },
  };
  return agent;
}
