/**
 * The Assistant tab of the Docs side panel. The owner asks for edits, asks
 * questions, or has the draft reviewed against instructions; edits arrive as
 * tracked changes by "Matrix Assistant" and are listed in a result card with
 * jump links, Accept all, Reject all and one-by-one review.
 *
 * Built on the office-ui `AgentPanel`; the flows are `../../agent`.
 */

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { AgentPanel, ReviewBar, aiAccessMessage, useAiAccess } from "../../../../_shared/office-ui";
import type { AiAccess, AiAccessBridge } from "../../../../_shared/office-ui";
import type { AgentResult } from "../../../../_shared/office-ui";
import { MAX_INSTRUCTION_CHARS, QUICK_ACTIONS } from "../../agent/index";
import type { AgentGenerate } from "../../agent/index";
import type { TextRange } from "../../../../_shared/office-engine/index";
import type { DocumentEditorController } from "../../editor/index";
import type { DocumentSession } from "../../session/index";
import type { AssistantRequest, AssistantRequestId } from "../panel-types";
import { AnswerBody, EditCardBody } from "./AgentCards";
import type { JumpTarget } from "./AgentCards";
import { AssistantStore } from "./assistant-store";
import type { AssistantCard, AssistantMode } from "./assistant-store";
import "./docs-agent.css";

export interface DocsAgentPanelProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  /** Accepted for the side panel contract; the side panel shows the one close button. */
  onClose?: () => void;
  /** True in the read-only (original) view: nothing is changed from the panel. */
  readOnly?: boolean;
  /** The model call. Default `window.MatrixOS.ai.generate`. */
  generate?: AgentGenerate;
  /** Accepted for the side panel contract; not used here. */
  pickDocument?: unknown;
  review?: unknown;
  /** A request from the ribbon: runs once AI access is known, then `onAssistantRequestHandled` is called. */
  assistantRequest?: AssistantRequest | null;
  onAssistantRequestHandled?: () => void;
}

const MODES: ReadonlyArray<{ id: AssistantMode; label: string; placeholder: string }> = [
  { id: "edit", label: "Edit", placeholder: "Describe the change, e.g. “Make the payment term 45 days”…" },
  { id: "ask", label: "Ask", placeholder: "Ask about the document, e.g. “When can the customer terminate?”…" },
  { id: "review", label: "Review", placeholder: "Paste the instructions the draft must follow…" },
];

function bridge(): AiAccessBridge | undefined {
  return typeof window === "undefined" ? undefined : (window.MatrixOS as AiAccessBridge | undefined);
}

function logCheck(message: string, error: unknown): void {
  console.warn(message, error instanceof Error ? error.name : error);
}

function bridgeGenerate(): AgentGenerate | null {
  const ai = typeof window === "undefined" ? undefined : window.MatrixOS?.ai;
  if (ai === undefined || typeof ai.generate !== "function") return null;
  return (input) => ai.generate(input);
}

/** The model the panel uses, its access, and why the assistant is off when it is. */
function useAssistantModel(generate: AgentGenerate | undefined): { model: AgentGenerate | null; access: AiAccess; hint: string | null } {
  const model = useMemo(() => generate ?? bridgeGenerate(), [generate]);
  // The host answers only apps the owner allowed: ask before offering the assistant.
  const access = useAiAccess(bridge(), generate !== undefined ? "available" : undefined, logCheck);
  if (model === null) return { model, access: "unavailable", hint: aiAccessMessage("unavailable", "Docs", "docs") };
  return { model, access, hint: access === "available" ? null : aiAccessMessage(access, "Docs", "docs") };
}

/** Runs a ribbon request on the store. Requests that need the model wait for access and are dropped without it (the panel says why). */
function runRequest(store: AssistantStore, id: AssistantRequestId, access: AiAccess, readOnly: boolean): void {
  if (id === "fix-numbering") {
    if (!readOnly) store.fixStructure();
    return;
  }
  if (access !== "available") return;
  if (id === "explain") void store.explain();
  else if (id === "summarise" || !readOnly) void store.runQuickAction(id);
}

function selectionOf(editor: DocumentEditorController | null): TextRange | null {
  const selection = editor?.getSelection() ?? null;
  if (selection === null || selection.collapsed) return null;
  return { start: selection.start, end: selection.end };
}

const noSubscription = () => () => undefined;
const noSelection = () => null;

export function DocsAgentPanel({ session, editor, readOnly = false, generate, assistantRequest = null, onAssistantRequestHandled }: DocsAgentPanelProps) {
  const { model, access, hint } = useAssistantModel(generate);
  const editorRef = useRef(editor);
  const modelRef = useRef(model);
  useEffect(() => {
    editorRef.current = editor;
    modelRef.current = model;
  }, [editor, model]);
  const store = useMemo(
    () =>
      new AssistantStore({
        session,
        generate: (input) => (modelRef.current ?? rejectGenerate)(input),
        getSelection: () => selectionOf(editorRef.current),
        log: (message, error) => console.warn(message, error instanceof Error ? error.name : error),
      }),
    [session],
  );
  const state = useSyncExternalStore(store.subscribe, store.getState);
  // Re-render when the document changes, so pending counts follow accept, reject and undo elsewhere.
  useSyncExternalStore(session.subscribe, session.getState);
  const hasSelection = useSyncExternalStore(editor?.subscribe ?? noSubscription, editor ? () => editor.getSnapshot().selection?.collapsed === false : noSelection) === true;
  useEffect(() => () => store.cancel(), [store]);
  // Each request object runs once, also when effects run twice in development.
  const handledRequest = useRef<AssistantRequest | null>(null);
  useEffect(() => {
    if (assistantRequest === null || handledRequest.current === assistantRequest) return;
    if (access === "checking" && assistantRequest.id !== "fix-numbering") return;
    handledRequest.current = assistantRequest;
    onAssistantRequestHandled?.();
    runRequest(store, assistantRequest.id, access, readOnly);
  }, [assistantRequest, access, store, readOnly, onAssistantRequestHandled]);

  const jump = (target: JumpTarget) => {
    if (editor === null) return;
    if (target.range !== null && editor.setSelection(target.range, { scroll: true })) return;
    editor.scrollTo(target.blockId);
  };

  const mode = MODES.find((entry) => entry.id === state.mode) ?? MODES[0]!;
  const unavailable = hint !== null;
  const results: AgentResult[] = state.cards.map((card) => toResult(card, store, jump, readOnly, state.busy));
  const review = state.review;
  const reviewChanges = review !== null ? store.pendingChanges(review.cardId) : [];

  return (
    <div className="docs-agent">
      <div className="docs-agent__bar">
        <div className="docs-agent__modes" role="group" aria-label="Assistant mode">
          {MODES.map((entry) => (
            <button key={entry.id} type="button" className="docs-agent__mode" aria-pressed={state.mode === entry.id} onClick={() => store.setMode(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
        <span className="docs-agent__spacer" />
        <button type="button" className="oui-button oui-button--ghost" disabled={!hasSelection || state.busy || unavailable} onClick={() => void store.explain()}>
          Explain selection
        </button>
        <button type="button" className="oui-button oui-button--ghost" disabled={state.busy || readOnly || session.document === null} onClick={() => store.fixStructure()}>
          Fix numbering
        </button>
      </div>
      {review !== null && reviewChanges.length > 0 && (
        <ReviewBar
          className="docs-agent__review"
          noun="revision"
          total={reviewChanges.length}
          index={Math.min(review.index, reviewChanges.length - 1)}
          onPrevious={() => jumpTo(store.moveReview(-1), jump)}
          onNext={() => jumpTo(store.moveReview(1), jump)}
          onAccept={() => jumpTo(store.resolveCurrent("accept"), jump)}
          onReject={() => jumpTo(store.resolveCurrent("reject"), jump)}
          onAcceptAll={() => {
            store.acceptAll(review.cardId);
            store.stopReview();
          }}
          onRejectAll={() => {
            store.rejectAll(review.cardId);
            store.stopReview();
          }}
          busy={readOnly}
        />
      )}
      <AgentPanel
        title="Assistant"
        onSubmit={(prompt) => void store.submit(prompt)}
        messages={state.messages}
        statusLines={state.statusLines}
        results={results}
        busy={state.busy}
        onCancel={() => store.cancel()}
        suggestions={QUICK_ACTIONS.map((action) => action.label)}
        placeholder={mode.placeholder}
        disabled={unavailable || session.document === null || (readOnly && state.mode !== "ask")}
        maxLength={MAX_INSTRUCTION_CHARS}
        emptyHint={
          <p>
            {hint ?? "Ask for a change and it arrives as tracked changes you accept or reject. Switch to Ask for questions about the document."}
          </p>
        }
      />
    </div>
  );
}

function jumpTo(change: { blockId: string; range: TextRange | null } | null, jump: (target: JumpTarget) => void): void {
  if (change !== null) jump({ blockId: change.blockId, range: change.range });
}

function toResult(card: AssistantCard, store: AssistantStore, jump: (target: JumpTarget) => void, readOnly: boolean, busy: boolean): AgentResult {
  if (card.type === "answer") return { id: card.id, title: card.title, status: "proposed", body: <AnswerBody segments={card.segments} onJump={jump} /> };
  const pending = store.pending(card.id).length;
  const counts = [`${card.changes.length} revision${card.changes.length === 1 ? "" : "s"}`];
  if (card.comments.length > 0) counts.push(`${card.comments.length} comment${card.comments.length === 1 ? "" : "s"}`);
  if (card.status === "mixed") counts.push(`${card.outcomes.accepted} accepted, ${card.outcomes.rejected} rejected`);
  else if (card.status === "proposed" && pending < card.revisionIds.length && card.revisionIds.length > 0) counts.push(`${pending} pending`);
  return {
    id: card.id,
    title: card.title,
    status: card.status === "mixed" ? "proposed" : card.status,
    meta: counts.join(" · "),
    body: (
      <EditCardBody
        card={card}
        pendingCount={pending}
        onJump={jump}
        onAcceptAll={() => store.acceptAll(card.id)}
        onRejectAll={() => store.rejectAll(card.id)}
        onReviewOneByOne={() => jumpTo(store.startReview(card.id), jump)}
        disabled={readOnly || busy}
      />
    ),
  };
}

async function rejectGenerate(): Promise<{ text: string }> {
  throw new Error("AI access is not available");
}

export default DocsAgentPanel;
