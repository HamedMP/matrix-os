import { useState, useSyncExternalStore } from "react";
import { AgentPanel, Toolbar, ToolbarButton } from "../../../../_shared/office-ui";
import type { AssistantState, SheetSelection, SheetsAssistant } from "../../agent";
import { type RunAction, toAgentResult } from "./ResultBody";
import "./agent.css";

export function useAssistantState(assistant: SheetsAssistant): AssistantState {
  return useSyncExternalStore(
    (listener) => assistant.subscribe(listener),
    () => assistant.getState(),
    () => assistant.getState(),
  );
}

export interface SheetsAgentPanelProps {
  assistant: SheetsAssistant;
  /** The selection actions apply to; usually `() => selectionFromGrid(gridController)`. */
  getSelection: () => SheetSelection | null;
  /** Called before an action reads the workbook, e.g. `gridController.commitEdit()`. False stops the action. */
  beforeAction?: () => boolean | void;
  onClose?: () => void;
  /** False when this host has no model: AI actions are off, the checks and formatting still work. */
  aiAvailable?: boolean;
  /** Why the assistant is off, shown in the panel when `aiAvailable` is false. */
  unavailableMessage?: string;
  className?: string;
}

const SUGGESTIONS = ["Clean and normalise the selected column", "Build a table of monthly costs here", "Make the total revenue a formula"];

/** The assistant side panel: quick actions, the conversation and result cards. */
export function SheetsAgentPanel({ assistant, getSelection, beforeAction, onClose, aiAvailable = true, unavailableMessage, className }: SheetsAgentPanelProps) {
  const state = useAssistantState(assistant);
  const [hint, setHint] = useState<string | null>(null);
  // Every action commits the cell editor first, and stops when it refused the text.
  const ready = (): boolean => beforeAction?.() !== false;
  const run: RunAction = (action) => {
    if (ready()) void action(assistant);
  };
  const results = state.results.map((result) => toAgentResult(result, run));

  const withSelection = (action: (selection: SheetSelection) => void) => () => {
    if (!ready()) return;
    const selection = getSelection();
    if (selection === null) {
      setHint("Select a cell or a range on the sheet first.");
      return;
    }
    setHint(null);
    action(selection);
  };

  return (
    <div className={`sheets-agent${className === undefined ? "" : ` ${className}`}`}>
      <Toolbar label="Assistant quick actions" className="sheets-agent__quick">
        <ToolbarButton label="Explain" showLabel disabled={state.busy || !aiAvailable} onClick={withSelection((selection) => void assistant.explain(selection))} />
        <ToolbarButton label="Trace" showLabel disabled={state.busy || !aiAvailable} onClick={withSelection((selection) => void assistant.trace(selection))} />
        <ToolbarButton
          label="Check for hard-coded values"
          showLabel
          disabled={state.busy}
          onClick={() => {
            if (!ready()) return;
            setHint(null);
            void assistant.check();
          }}
        />
        <ToolbarButton label="Format as table" showLabel disabled={state.busy} onClick={withSelection((selection) => void assistant.formatTable(selection))} />
      </Toolbar>
      {hint !== null && (
        <p className="sheets-agent__hint" role="status">
          {hint}
        </p>
      )}
      <AgentPanel
        className="sheets-agent__panel"
        title="Assistant"
        messages={state.messages}
        statusLines={state.statusLines}
        results={results}
        busy={state.busy}
        onCancel={() => assistant.cancel()}
        onClose={onClose}
        suggestions={aiAvailable ? SUGGESTIONS : []}
        disabled={!aiAvailable}
        placeholder={aiAvailable ? "Ask for a change, a table, or an explanation…" : "The assistant is not available here."}
        emptyHint={
          <p>
            {aiAvailable
              ? "Changes the assistant makes are proposals: they appear in review with old and new values until you accept or reject them."
              : (unavailableMessage ?? "The assistant is not available here. The checks and formatting above still work.")}
          </p>
        }
        onSubmit={(prompt) => withSelection((selection) => void assistant.ask(prompt, selection))()}
      />
    </div>
  );
}
