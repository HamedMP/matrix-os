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

export { SheetsAgentPanel, selectionFromGrid, useAssistantState } from "./SheetsAgentPanel";
export type { SelectionSource, SheetsAgentPanelProps } from "./SheetsAgentPanel";
export { toAgentResult } from "./ResultBody";
