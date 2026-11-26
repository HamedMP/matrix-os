/**
 * State of the Assistant panel, without React: the conversation, progress
 * lines, result cards and the one-by-one review cursor. It runs the
 * assistant flows of `../../agent` and resolves revisions through the
 * session. Bounded: old messages and cards are dropped.
 *
 * One store belongs to one open document (`documentKey`) and outlives the
 * panel: the workspace keeps it while the owner switches tabs. A card's
 * status is derived from the revisions still pending in the document, so it
 * follows undo and accept or reject done in the Review panel.
 */

import {
  PARTIAL_COVERAGE_NOTE,
  QUICK_ACTIONS,
  READ_ONLY_MESSAGE,
  askDocument,
  explainSelection,
  fixNumberingAndReferences,
  readingQuickActions,
  runAssistantEdit,
  summariseDocument,
} from "../../agent/index";
import { addListener } from "../../listeners";
import type {
  AgentGenerate,
  AgentProgress,
  AnswerResult,
  AnswerSegment,
  ChangeSummaryItem,
  CommentSummaryItem,
  DroppedEdit,
  EditRunResult,
  QuickActionId,
} from "../../agent/index";
import type { Revision, TextRange } from "../../../../_shared/office-engine/index";
import {
  type CardView,
  type ChangeOutcome,
  type Lineage,
  WHOLE_CARD,
  cardRevisions,
  changeKey,
  changeRevisions,
  deriveCardView,
  splitPieces,
  unitKeys,
  withPieces,
  withoutReopened,
} from "./card-revisions";
import type { DocumentChange, DocumentSession } from "../../session/index";

export const MAX_MESSAGES = 40;
export const MAX_CARDS = 20;

export type AssistantMode = "edit" | "ask" | "review";

export interface Message {
  id: string;
  role: "user" | "agent";
  text: string;
}

export interface StatusLine {
  id: string;
  text: string;
  state: "pending" | "running" | "done" | "error";
}

export type { CardStatus, CardView, ChangeOutcome } from "./card-revisions";

export type AssistantCard =
  | {
      id: string;
      type: "edit";
      title: string;
      documentKey: number;
      summary: string | null;
      changes: ChangeSummaryItem[];
      comments: CommentSummaryItem[];
      revisionIds: string[];
      /** Owner-facing notes, e.g. how many proposals were dropped. */
      notes: string[];
      /**
       * How the owner resolved each change from this card, by change key. An
       * entry is dropped when its change is pending again (undo), so it never
       * outlives the resolution it describes.
       */
      resolutions: Readonly<Record<string, ChangeOutcome>>;
      /**
       * Revisions the document split off this card's revisions later (the
       * owner typed inside one), each with the original revision of the card
       * it came from, so it stays with that revision's change.
       */
      pieces?: Readonly<Record<string, string>>;
    }
  | { id: string; type: "answer"; title: string; documentKey: number; segments: AnswerSegment[]; notes: string[] };

type EditCard = Extract<AssistantCard, { type: "edit" }>;

export interface ReviewCursor {
  cardId: string;
  index: number;
}

export interface AssistantState {
  mode: AssistantMode;
  messages: Message[];
  statusLines: StatusLine[];
  cards: AssistantCard[];
  busy: boolean;
  review: ReviewCursor | null;
}

export interface AssistantLinks {
  generate: AgentGenerate;
  /** The owner's selection in engine coordinates, or null. */
  getSelection: () => TextRange | null;
  /** True in the read-only (Original) view: requests that would change the document are refused. */
  readOnly?: boolean;
}

export interface AssistantStoreOptions extends AssistantLinks {
  session: DocumentSession;
  log?: (message: string, error: unknown) => void;
}

const INITIAL: AssistantState = { mode: "edit", messages: [], statusLines: [], cards: [], busy: false, review: null };

function droppedNote(dropped: readonly DroppedEdit[]): string[] {
  if (dropped.length === 0) return [];
  const notShown = dropped.filter((entry) => entry.code === "out_of_scope" || entry.code === "not_found").length;
  const stale = dropped.length - notShown;
  const parts: string[] = [];
  if (stale > 0) parts.push(`${stale} proposed change${stale === 1 ? "" : "s"} no longer matched the document and ${stale === 1 ? "was" : "were"} left out`);
  if (notShown > 0) parts.push(`${notShown} pointed at paragraphs the assistant was not shown and ${notShown === 1 ? "was" : "were"} left out`);
  return [`${parts.join("; ")}.`];
}

export class AssistantStore {
  private state: AssistantState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private counter = 0;
  private controller: AbortController | null = null;
  private links: AssistantLinks;
  /** The document this store belongs to. */
  readonly documentKey: number;
  /** The document's revisions when the store last looked, to find what the next change splits off. */
  private seen: readonly Revision[] = [];

  constructor(private readonly options: AssistantStoreOptions) {
    this.links = { generate: options.generate, getSelection: options.getSelection, readOnly: options.readOnly };
    this.documentKey = options.session.getState().documentKey;
  }

  /** The model and selection of the panel now showing this store. */
  connect(links: AssistantLinks): void {
    this.links = links;
  }

  /** The store is no longer kept: stops a running request and drops its listeners. */
  dispose(): void {
    this.cancel();
    this.listeners.clear();
  }

  getState = (): AssistantState => this.state;

  subscribe = (listener: () => void): (() => void) => addListener(this.listeners, listener, "assistant");

  setMode(mode: AssistantMode): void {
    this.patch({ mode });
  }

  /** The prompt box: an edit, a question or review instructions, by mode. A quick-action label runs that action (reading ones only in the read-only view). */
  submit(prompt: string): Promise<void> {
    const action = readingQuickActions(this.links.readOnly === true).find((entry) => entry.label === prompt);
    if (action !== undefined) return this.runQuickAction(action.id);
    if (this.state.mode === "ask") return this.ask(prompt);
    if (this.state.mode === "review") return this.reviewAgainst(prompt);
    return this.edit(prompt);
  }

  async runQuickAction(id: QuickActionId): Promise<void> {
    const action = QUICK_ACTIONS.find((entry) => entry.id === id);
    if (action === undefined) return;
    if (action.kind !== "answer" && this.refuseInReadOnly()) return;
    if (action.kind === "review") {
      this.patch({ mode: "review" });
      this.say("agent", "Type or paste the instructions the draft must follow and send them. I will comment wherever the draft deviates and change no text.");
      return;
    }
    if (action.kind === "answer") {
      this.say("user", action.label);
      await this.run("Summary", (signal, onProgress) => summariseDocument(this.deps(), { signal, onProgress }));
      return;
    }
    this.say("user", action.label);
    await this.runEdit(action.label, action.instruction, "edit");
  }

  edit(instruction: string): Promise<void> {
    if (this.refuseInReadOnly()) return Promise.resolve();
    this.say("user", instruction);
    return this.runEdit("Proposed changes", instruction, "edit");
  }

  reviewAgainst(instructions: string): Promise<void> {
    if (this.refuseInReadOnly()) return Promise.resolve();
    this.say("user", instructions);
    return this.runEdit("Review comments", instructions, "comment");
  }

  ask(question: string): Promise<void> {
    this.say("user", question);
    return this.run("Answer", (signal, onProgress) => askDocument(this.deps(), { question, selection: this.links.getSelection(), signal, onProgress }));
  }

  explain(): Promise<void> {
    this.say("user", "Explain the selection");
    return this.run("Explanation", (signal, onProgress) => explainSelection(this.deps(), { selection: this.links.getSelection(), signal, onProgress }));
  }

  fixStructure(): void {
    if (this.state.busy || this.refuseInReadOnly()) return;
    this.say("user", "Fix numbering and cross-references");
    const result = fixNumberingAndReferences(this.options.session, { log: this.options.log });
    if (result.status === "failed") return this.say("agent", result.message);
    if (result.status === "no_changes" || (result.changes.length === 0 && result.comments.length === 0)) {
      return this.say("agent", "Numbering and cross-references are consistent. Nothing to fix.");
    }
    const notes: string[] = [];
    if (result.updatedReferences > 0) notes.push(`${result.updatedReferences} cross-reference${result.updatedReferences === 1 ? "" : "s"} updated to the new numbers.`);
    if (result.brokenReferences > 0) notes.push(`${result.brokenReferences} cross-reference${result.brokenReferences === 1 ? " points" : "s point"} to no clause; see the comments.`);
    this.addCard({
      id: this.nextId("card"),
      type: "edit",
      title: "Numbering fixes",
      documentKey: this.options.session.getState().documentKey,
      summary: result.labelChanges.length > 0 ? `${result.labelChanges.length} clause number${result.labelChanges.length === 1 ? "" : "s"} corrected.` : null,
      changes: result.changes,
      comments: result.comments,
      revisionIds: result.revisionIds,
      notes,
      resolutions: {},
    });
  }

  cancel(): void {
    this.controller?.abort();
  }

  /** Revision ids of a card still pending in the document, split pieces included (empty for a card of another document). */
  pending(cardId: string): string[] {
    return this.pendingRevisions(cardId).map((revision) => revision.id);
  }

  acceptAll(cardId: string): void {
    this.resolve(cardId, this.pending(cardId), "accept", [...this.pendingUnits(cardId)]);
  }

  rejectAll(cardId: string): void {
    this.resolve(cardId, this.pending(cardId), "reject", [...this.pendingUnits(cardId)]);
  }

  /** What a card shows now: derived from the pending revisions, so it follows undo and Review. */
  view(cardId: string): CardView {
    const card = this.card(cardId);
    const pending = this.pending(cardId).length;
    if (card?.type !== "edit") return { status: "proposed", pending, accepted: 0, rejected: 0, elsewhere: 0 };
    return deriveCardView(unitKeys(card), this.pendingUnits(cardId), card.resolutions, pending);
  }

  /** Changes of a card still pending, the unit of one-by-one review. */
  pendingChanges(cardId: string): ChangeSummaryItem[] {
    const card = this.card(cardId);
    if (card?.type !== "edit") return [];
    const pending = this.pendingRevisions(cardId);
    return card.changes.filter((change) => changeRevisions(pending, change.revisionIds, card.pieces ?? {}).length > 0);
  }

  startReview(cardId: string): ChangeSummaryItem | null {
    const changes = this.pendingChanges(cardId);
    if (changes.length === 0) return null;
    this.patch({ review: { cardId, index: 0 } });
    return changes[0] as ChangeSummaryItem;
  }

  stopReview(): void {
    this.patch({ review: null });
  }

  /** Moves the cursor and returns the change it lands on. */
  moveReview(delta: number): ChangeSummaryItem | null {
    const review = this.state.review;
    if (review === null) return null;
    const changes = this.pendingChanges(review.cardId);
    if (changes.length === 0) return this.endReview();
    const index = (review.index + delta + changes.length) % changes.length;
    this.patch({ review: { ...review, index } });
    return changes[index] as ChangeSummaryItem;
  }

  /** Accepts or rejects the current change, then returns the next one (null when none is left). */
  resolveCurrent(action: "accept" | "reject"): ChangeSummaryItem | null {
    const review = this.state.review;
    if (review === null) return null;
    const changes = this.pendingChanges(review.cardId);
    const current = changes[Math.min(review.index, changes.length - 1)];
    if (current === undefined) return this.endReview();
    const card = this.card(review.cardId);
    const pieces = card?.type === "edit" ? (card.pieces ?? {}) : {};
    this.resolve(review.cardId, changeRevisions(this.pendingRevisions(review.cardId), current.revisionIds, pieces), action, [changeKey(current)]);
    const left = this.pendingChanges(review.cardId);
    if (left.length === 0) return this.endReview();
    const index = Math.min(review.index, left.length - 1);
    this.patch({ review: { ...review, index } });
    return left[index] as ChangeSummaryItem;
  }

  // ---------------------------------------------------------------- internals

  /** True (and says why) when the read-only view refuses a request that would change the document. */
  private refuseInReadOnly(): boolean {
    if (this.links.readOnly !== true) return false;
    this.say("agent", READ_ONLY_MESSAGE);
    return true;
  }

  private endReview(): null {
    this.patch({ review: null });
    return null;
  }

  private deps() {
    return { session: this.options.session, generate: this.links.generate, log: this.options.log };
  }

  /** Keys of the card's units with revisions still pending. */
  private pendingUnits(cardId: string): Set<string> {
    const card = this.card(cardId);
    if (card?.type !== "edit") return new Set();
    if (card.changes.length === 0) return new Set(this.pendingRevisions(cardId).length > 0 ? [WHOLE_CARD] : []);
    return new Set(this.pendingChanges(cardId).map(changeKey));
  }

  /**
   * Call after every change to the active document (`session.onChange`),
   * also while no panel shows the store: a request for a document that is no
   * longer open is stopped, and a resolution whose change is pending again
   * (undo) is forgotten, so the card's counts stay true.
   */
  documentChanged(change: DocumentChange): void {
    if (change.kind === "load" || change.kind === "close" || this.options.session.getState().documentKey !== this.documentKey) {
      this.cancel();
      return;
    }
    this.trackSplits();
    let cards: AssistantCard[] | null = null;
    for (const card of this.state.cards) {
      if (card.type !== "edit") continue;
      const kept = withoutReopened(card.resolutions, this.pendingUnits(card.id));
      if (kept === card.resolutions) continue;
      cards ??= [...this.state.cards];
      cards[cards.indexOf(card)] = { ...card, resolutions: kept };
    }
    if (cards !== null) this.patch({ cards });
  }

  private pendingRevisions(cardId: string): Revision[] {
    const card = this.card(cardId);
    const doc = this.options.session.document;
    const documentKey = this.options.session.getState().documentKey;
    if (card?.type !== "edit" || doc === null || card.documentKey !== documentKey) return [];
    // Revisions another card names by id stay with that card.
    const claimed = new Set<string>();
    for (const other of this.state.cards) {
      if (other.type === "edit" && other.id !== cardId && other.documentKey === documentKey) for (const id of other.revisionIds) claimed.add(id);
    }
    return cardRevisions(doc.listRevisions(), card.revisionIds, card.pieces ?? {}, claimed);
  }

  /** Ties each revision the last change split off a card's revision to that card and to the original revision it came from. */
  private trackSplits(): void {
    const doc = this.options.session.document;
    const edits = this.state.cards.filter((card): card is EditCard => card.type === "edit" && card.documentKey === this.documentKey);
    if (doc === null || edits.length === 0) return;
    const before = this.seen;
    this.seen = doc.listRevisions();
    const lineages = new Map<string, Lineage>();
    for (const card of edits) {
      for (const id of card.revisionIds) lineages.set(id, { card: card.id, origin: id });
      for (const [id, origin] of Object.entries(card.pieces ?? {})) lineages.set(id, { card: card.id, origin });
    }
    const found = splitPieces(before, this.seen, (id) => lineages.get(id));
    if (found.size > 0) this.patch({ cards: this.state.cards.map((card) => (card.type === "edit" ? withPieces(card, found) : card)) });
  }

  private card(cardId: string): AssistantCard | undefined {
    return this.state.cards.find((card) => card.id === cardId);
  }

  /** `units` are the keys of the changes the ids make up, for the card's record of outcomes. */
  private resolve(cardId: string, ids: string[], action: "accept" | "reject", units: string[]): void {
    if (ids.length === 0 || this.refuseInReadOnly()) return;
    try {
      if (action === "accept") this.options.session.acceptRevisions(ids, { origin: "review" });
      else this.options.session.rejectRevisions(ids, { origin: "review" });
    } catch (error) {
      this.options.log?.("docs assistant: resolving revisions failed", error);
      this.say("agent", "Those changes could not be resolved. They may have changed; review them in the document.");
      return;
    }
    const card = this.card(cardId);
    if (card?.type !== "edit") return;
    const outcome: ChangeOutcome = action === "accept" ? "accepted" : "rejected";
    const resolutions = { ...card.resolutions };
    for (const key of units) resolutions[key] = outcome;
    this.replaceCard({ ...card, resolutions });
  }

  private async runEdit(title: string, instruction: string, mode: "edit" | "comment"): Promise<void> {
    await this.run(title, (signal, onProgress) =>
      runAssistantEdit(this.deps(), { instruction, mode, selection: this.links.getSelection(), signal, onProgress }),
    );
  }

  private async run(title: string, work: (signal: AbortSignal, onProgress: (progress: AgentProgress) => void) => Promise<EditRunResult | AnswerResult>): Promise<void> {
    if (this.state.busy) return;
    const controller = new AbortController();
    this.controller = controller;
    this.patch({ busy: true, statusLines: [] });
    const documentKey = this.options.session.getState().documentKey;
    let result: EditRunResult | AnswerResult;
    try {
      result = await work(controller.signal, (progress) => this.progress(progress));
    } catch (error) {
      this.options.log?.("docs assistant: the request failed", error);
      result = { status: "failed", reason: "unavailable", message: "The assistant is unavailable right now. Try again." };
    } finally {
      if (this.controller === controller) this.controller = null;
    }
    this.finish(result.status === "failed" || result.status === "invalid_reply" ? "error" : "done");
    this.patch({ busy: false });
    this.present(title, documentKey, result);
  }

  private present(title: string, documentKey: number, result: EditRunResult | AnswerResult): void {
    switch (result.status) {
      case "cancelled":
        return this.say("agent", "Stopped. Nothing was changed.");
      case "failed":
      case "invalid_reply":
        return this.say("agent", result.message);
      case "answered":
        return this.addCard({ id: this.nextId("card"), type: "answer", title, documentKey, segments: result.segments, notes: result.partial ? [PARTIAL_COVERAGE_NOTE] : [] });
      case "no_changes":
        return this.say("agent", ["No changes proposed.", ...droppedNote(result.dropped), ...(result.partial ? [PARTIAL_COVERAGE_NOTE] : [])].join(" "));
      case "applied":
        return this.addCard({
          id: this.nextId("card"),
          type: "edit",
          title,
          documentKey,
          summary: result.summary,
          changes: result.changes,
          comments: result.comments,
          revisionIds: result.revisionIds,
          notes: [...droppedNote(result.dropped), ...(result.partial ? [PARTIAL_COVERAGE_NOTE] : [])],
          resolutions: {},
        });
    }
  }

  private progress(progress: AgentProgress): void {
    const lines = this.state.statusLines.map((line) => (line.state === "running" ? { ...line, state: "done" as const } : line));
    if (lines.at(-1)?.text !== progress.message) lines.push({ id: this.nextId("line"), text: progress.message, state: progress.phase === "done" ? "done" : "running" });
    this.patch({ statusLines: lines.slice(-12) });
  }

  private finish(state: "done" | "error"): void {
    const lines = this.state.statusLines.map((line, index, all) => (line.state === "running" || index === all.length - 1 ? { ...line, state: index === all.length - 1 ? state : "done" } : line));
    this.patch({ statusLines: lines });
  }

  private say(role: Message["role"], text: string): void {
    this.patch({ messages: [...this.state.messages, { id: this.nextId("msg"), role, text }].slice(-MAX_MESSAGES) });
  }

  private addCard(card: AssistantCard): void {
    const doc = this.options.session.document;
    // Splits are found against the document as the card first sees it.
    if (card.type === "edit" && doc !== null && card.documentKey === this.documentKey && this.options.session.getState().documentKey === this.documentKey) {
      this.seen = doc.listRevisions();
    }
    this.patch({ cards: [...this.state.cards, card].slice(-MAX_CARDS) });
  }

  private replaceCard(card: AssistantCard): void {
    this.patch({ cards: this.state.cards.map((entry) => (entry.id === card.id ? card : entry)) });
  }

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private patch(partial: Partial<AssistantState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.options.log?.("docs assistant: a listener failed", error);
      }
    }
  }
}

