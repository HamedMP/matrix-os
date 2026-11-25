/**
 * The assistant's conversation for the panel: one action at a time, progress
 * lines, result cards, highlights on the grid, and accepting or rejecting
 * what it proposed. The actions themselves live in the sibling modules.
 */

import type { CellDecoration } from "../grid";
import { type SheetsAi, SheetsAgentError } from "./ai";
import type { AgentSession } from "./apply";
import { type Finding, checkWorkbook } from "./checks";
import { cleanColumn } from "./clean";
import type { AgentContext, ExplainOutcome, ProposalOutcome, SheetSelection } from "./context";
import { buildTable, editByInstruction } from "./edit";
import type { CellAddress, CellRange, SheetCellRef, SheetId } from "./engine";
import { explainSelection, narrateTrace } from "./explain";
import { type AssistantResult, type ProposalResult, pendingOf, resolvedStatus, snapshotProposal } from "./results";
import { type AssistantIntent, routeInstruction } from "./routing";
import { fixFinding, formatAsTable } from "./table-format";
import { oneLine } from "./untrusted";

export const SOURCES_LAYER = "assistant-sources";
export const FINDINGS_LAYER = "assistant-findings";
const MAX_MESSAGES = 100;
const MAX_RESULTS = 50;
const MAX_LISTENERS = 32;

/** The parts of `SheetGridController` the assistant uses. */
export interface AssistantGrid {
  select(target: CellAddress | CellRange, sheet?: SheetId): void;
  decorate(layer: string, decorations: readonly CellDecoration[]): void;
  clearDecorations(layer?: string): void;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "agent";
  text: string;
}

export interface AssistantStatusLine {
  id: string;
  text: string;
  state: "pending" | "running" | "done" | "error";
}

export interface AssistantState {
  messages: AssistantMessage[];
  statusLines: AssistantStatusLine[];
  results: AssistantResult[];
  busy: boolean;
}

export interface AssistantDeps {
  session: AgentSession;
  ai: SheetsAi | null;
  grid?: AssistantGrid | null;
  now?: () => Date;
  log?: (message: string, error: unknown) => void;
  /** Opens change review at a proposal. */
  onReview?: (proposalId: string, firstChangeId: string | null) => void;
}

const FAILED = "Something went wrong. Nothing was changed.";

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export class SheetsAssistant {
  private state: AssistantState = { messages: [], statusLines: [], results: [], busy: false };
  private readonly listeners = new Set<() => void>();
  private unsubscribe: (() => void) | null = null;
  private grid: AssistantGrid | null;
  private controller: AbortController | null = null;
  private seq = 0;
  private disposed = false;

  constructor(private readonly deps: AssistantDeps) {
    this.grid = deps.grid ?? null;
    this.attach();
  }

  /**
   * Follows the session's changes; the constructor does this. After
   * `dispose`, attaching again brings the cards up to date and resumes, so a
   * component can dispose in an effect's cleanup and attach in its setup.
   */
  attach(): void {
    if (this.unsubscribe !== null) return;
    this.disposed = false;
    // An action cancelled by `dispose` that ended meanwhile could not clear `busy`.
    if (this.state.busy && this.controller === null) this.state = { ...this.state, busy: false };
    this.unsubscribe = this.deps.session.subscribe((event) => {
      if (event.type === "change") this.syncProposals();
    });
    this.syncProposals();
  }

  getState(): AssistantState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error("too many assistant listeners");
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setGrid(grid: AssistantGrid | null): void {
    this.clearHighlights();
    this.grid = grid;
  }

  // ------------------------------------------------------------ actions

  /** Runs what a typed instruction asks for. */
  ask(text: string, selection: SheetSelection): Promise<void> {
    return this.runIntent(routeInstruction(text), text, selection);
  }

  runIntent(intent: AssistantIntent, text: string, selection: SheetSelection): Promise<void> {
    switch (intent) {
      case "explain":
        return this.explain(selection, text);
      case "trace":
        return this.trace(selection, text);
      case "check":
        return this.check(text);
      case "format-table":
        return this.formatTable(selection, text);
      case "build-table":
        return this.run(text, ["Reading the sheet", "Asking the assistant for the table", "Checking the proposed cells"], (ctx) => buildTable(ctx, text, selection).then((outcome) => this.onProposal(outcome)));
      case "clean-column":
        return this.cleanColumn(selection, text);
      case "edit":
        return this.run(text, ["Reading the sheet", "Asking the assistant", "Checking the proposed changes"], (ctx) => editByInstruction(ctx, text, selection).then((outcome) => this.onProposal(outcome)));
    }
  }

  explain(selection: SheetSelection, text = "Explain the selection"): Promise<void> {
    return this.run(text, ["Reading the formula and its inputs", "Asking the assistant"], async (ctx) => this.onAnswer(await explainSelection(ctx, selection), "Explanation"));
  }

  trace(selection: SheetSelection, text = "Trace where this value comes from"): Promise<void> {
    return this.run(text, ["Following the formulas to their inputs", "Asking the assistant to narrate"], async (ctx) => this.onAnswer(await narrateTrace(ctx, selection.sheet, selection.range.start), "Trace"));
  }

  check(text = "Check for hard-coded values"): Promise<void> {
    return this.run(text, ["Checking every sheet"], async (ctx) => this.onFindings(checkWorkbook(ctx.session.workbook)));
  }

  formatTable(selection: SheetSelection, text = "Format as table"): Promise<void> {
    return this.run(text, ["Formatting the table"], async (ctx) => this.onProposal(formatAsTable(ctx, selection)));
  }

  cleanColumn(selection: SheetSelection, text = ""): Promise<void> {
    const instruction = /^\s*clean (?:and normali[sz]e )?(?:the )?(?:selected )?column\.?\s*$/i.test(text) ? "" : text;
    const steps = instruction === "" ? ["Tidying the column"] : ["Tidying the column", "Asking the assistant", "Checking the proposed cells"];
    return this.run(text || "Clean the column", steps, (ctx) => cleanColumn(ctx, selection.sheet, selection.range.start.col, instruction).then((outcome) => this.onProposal(outcome)));
  }

  /** Proposes linking a typed-in total to the formula it disagrees with. */
  fix(finding: Finding): Promise<void> {
    return this.run(`Fix ${finding.location}`, ["Proposing the fix"], async (ctx) => this.onProposal(fixFinding(ctx, finding)));
  }

  /** Selects a finding's cell on the grid. */
  showFinding(finding: Finding): void {
    this.reveal({ sheet: finding.sheet, row: finding.row, col: finding.col });
  }

  /** Stops the running action. Nothing it would have proposed is applied. */
  cancel(): void {
    this.controller?.abort();
  }

  // ------------------------------------------------------------ results

  acceptResult(id: string): void {
    this.resolve(id, true);
  }

  rejectResult(id: string): void {
    this.resolve(id, false);
  }

  /** Opens review at the proposal's first pending change. */
  reviewResult(id: string): void {
    const result = this.proposal(id);
    if (result === null) return;
    const pending = pendingOf(this.deps.session.workbook, result.proposalId);
    this.deps.onReview?.(result.proposalId, pending[0] ?? null);
  }

  private proposal(id: string): ProposalResult | null {
    const result = this.state.results.find((entry) => entry.id === id);
    return result !== undefined && result.kind === "proposal" ? result : null;
  }

  private resolve(id: string, accept: boolean): void {
    const result = this.proposal(id);
    if (result === null || result.status !== "proposed") return;
    const ids = pendingOf(this.deps.session.workbook, result.proposalId);
    try {
      if (ids.length > 0) {
        if (accept) this.deps.session.acceptChanges(ids);
        else this.deps.session.rejectChanges(ids);
      }
    } catch (error: unknown) {
      this.deps.log?.("resolving an assistant proposal failed", error);
      this.say("The changes could not be resolved. Open review to resolve them one by one.");
      return;
    }
    this.replaceResult({ ...result, status: accept ? "accepted" : "rejected", pending: 0 });
  }

  /** Brings proposal cards in line with the journal after review elsewhere. */
  private syncProposals(): void {
    if (this.disposed) return;
    const workbook = this.deps.session.workbook;
    let changed = false;
    const results = this.state.results.map((result) => {
      if (result.kind !== "proposal" || result.status !== "proposed") return result;
      const pending = pendingOf(workbook, result.proposalId).length;
      if (pending === result.pending) return result;
      changed = true;
      if (pending > 0) return { ...result, pending };
      return { ...result, pending, status: resolvedStatus(workbook, result.expected) };
    });
    if (changed) this.set({ results });
  }

  // ------------------------------------------------------------ highlights

  clearHighlights(): void {
    this.grid?.clearDecorations(SOURCES_LAYER);
    this.grid?.clearDecorations(FINDINGS_LAYER);
  }

  private highlight(layer: string, cells: readonly SheetCellRef[], kind: CellDecoration["kind"], label: (cell: SheetCellRef) => string): void {
    if (this.grid === null) return;
    const byCell = new Map<string, CellDecoration>();
    for (const cell of cells) {
      const key = `${cell.sheet}|${cell.row}|${cell.col}`;
      if (!byCell.has(key)) byCell.set(key, { sheet: cell.sheet, row: cell.row, col: cell.col, kind, label: label(cell) });
    }
    this.grid.decorate(layer, [...byCell.values()]);
  }

  private reveal(cell: SheetCellRef): void {
    try {
      this.grid?.select({ row: cell.row, col: cell.col }, cell.sheet);
    } catch (error: unknown) {
      this.deps.log?.("the assistant could not show a cell", error);
    }
  }

  // ------------------------------------------------------------ running

  private async run(text: string, steps: readonly string[], work: (ctx: AgentContext) => Promise<void>): Promise<void> {
    if (this.state.busy || this.disposed) return;
    const controller = new AbortController();
    this.controller = controller;
    const base = this.seq;
    this.seq += steps.length + 1;
    // Reading the workbook is synchronous, so the first step of a multi-step action is done by the time anyone looks.
    const running = steps.length > 1 ? 1 : 0;
    const lines: AssistantStatusLine[] = steps.map((step, index) => ({ id: `s${base + index}`, text: step, state: index < running ? "done" : index === running ? "running" : "pending" }));
    this.set({ busy: true, statusLines: lines, messages: this.withMessage("user", oneLine(text, 500)) });
    const ctx: AgentContext = { session: this.deps.session, ai: this.deps.ai, now: this.deps.now, signal: controller.signal, log: this.deps.log };
    try {
      await work(ctx);
      this.set({ statusLines: this.state.statusLines.map((line) => ({ ...line, state: "done" })) });
    } catch (error: unknown) {
      const message = error instanceof SheetsAgentError ? error.message : FAILED;
      if (!(error instanceof SheetsAgentError)) this.deps.log?.("an assistant action failed", error);
      this.set({ statusLines: this.state.statusLines.map((line) => (line.state === "done" ? line : { ...line, state: "error" })), messages: this.withMessage("agent", message) });
    } finally {
      if (this.controller === controller) this.controller = null;
      this.set({ busy: false });
    }
  }

  private onProposal(outcome: ProposalOutcome): void {
    if (outcome.status === "invalid") {
      this.say(`Nothing was changed: ${outcome.messages.join(" ")}`);
      return;
    }
    if (outcome.status === "no_changes") {
      this.say(outcome.summary || "Nothing needs to change.");
      return;
    }
    const workbook = this.deps.session.workbook;
    const count = outcome.changeIds.length;
    this.addResult({
      kind: "proposal",
      id: `r${this.seq++}`,
      title: capitalise(outcome.label.replace(/^Assistant: /, "")),
      summary: outcome.summary,
      status: "proposed",
      proposalId: outcome.proposalId,
      changeCount: count,
      pending: count,
      expected: snapshotProposal(workbook, outcome.proposalId),
    });
    this.say(`Proposed ${count === 1 ? "1 change" : `${count} changes`} for review.`);
  }

  private onAnswer(outcome: ExplainOutcome, title: string): void {
    this.highlight(SOURCES_LAYER, outcome.highlights, "precedent", () => `source of ${outcome.subject}`);
    this.addResult({ kind: "answer", id: `r${this.seq++}`, title: `${title}: ${outcome.subject}`, summary: "", subject: outcome.subject, text: outcome.text });
  }

  private onFindings(findings: Finding[]): void {
    const messages = (cell: SheetCellRef): string =>
      findings
        .filter((entry) => entry.sheet === cell.sheet && entry.row === cell.row && entry.col === cell.col)
        .map((entry) => entry.message)
        .join(" ");
    this.highlight(FINDINGS_LAYER, findings, "search", messages);
    const first = findings[0];
    if (first !== undefined) this.reveal(first);
    const title = findings.length === 0 ? "No hard-coded values or mismatched totals found" : `${findings.length === 1 ? "1 finding" : `${findings.length} findings`}`;
    this.addResult({ kind: "findings", id: `r${this.seq++}`, title, summary: "", findings });
  }

  // ------------------------------------------------------------ state

  private say(text: string): void {
    this.set({ messages: this.withMessage("agent", text) });
  }

  private withMessage(role: AssistantMessage["role"], text: string): AssistantMessage[] {
    return [...this.state.messages, { id: `m${this.seq++}`, role, text }].slice(-MAX_MESSAGES);
  }

  private addResult(result: AssistantResult): void {
    this.set({ results: [...this.state.results, result].slice(-MAX_RESULTS) });
  }

  private replaceResult(result: AssistantResult): void {
    this.set({ results: this.state.results.map((entry) => (entry.id === result.id ? result : entry)) });
  }

  private set(patch: Partial<AssistantState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error: unknown) {
        this.deps.log?.("an assistant listener failed", error);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.clearHighlights();
    this.disposed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.listeners.clear();
  }
}
