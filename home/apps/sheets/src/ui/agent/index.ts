/**
 * Assistant UI for the Sheets app.
 *
 * ```tsx
 * const assistant = useMemo(
 *   () => new SheetsAssistant({ session, ai: bridgeSheetsAi(), grid, onReview: (proposalId, changeId) => { openReview(); if (changeId) review.goTo(changeId); } }),
 *   [session, grid],
 * );
 * useEffect(() => () => assistant.dispose(), [assistant]);
 * <SheetsAgentPanel assistant={assistant} getSelection={() => selectionFromGrid(grid)} beforeAction={() => grid.commitEdit()} aiAvailable={bridgeSheetsAi() !== null} />
 * ```
 */

export { SheetsAgentPanel, useAssistantState } from "./SheetsAgentPanel";
export type { SheetsAgentPanelProps } from "./SheetsAgentPanel";
export { selectionFromGrid } from "./selection";
export type { SelectionSource } from "./selection";
export { toAgentResult } from "./ResultBody";
