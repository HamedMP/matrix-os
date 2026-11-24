/**
 * The Sheets assistant: pure orchestration over `MatrixOS.ai.generate`.
 *
 * - Model calls go through `askModel` (bounded prompt, timeout, typed errors).
 *   Prompts are built with `buildPrompt`: sheet text from `describeSheet`,
 *   wrapped as untrusted content, inside the 32 000-character bound.
 * - Edits come back as the engine's sheet envelope. `validateReply` parses
 *   them with `parseAgentEdits`, resolves them against the live workbook with
 *   `toSheetEdits` and checks the action's scope; one bad edit rejects the
 *   whole reply and nothing is applied.
 * - Every change is made inside one journal proposal authored
 *   "Matrix Assistant" (`runProposal`), so it can be reviewed and rejected.
 * - Tracing (`traceValue`) and the integrity checks (`checkWorkbook`) are
 *   done in code; the model only narrates.
 *
 * `SheetsAssistant` (./assistant) holds the conversation state for the panel.
 */

export { SheetsAgentError, askModel, bridgeSheetsAi } from "./ai";
export type { AskOptions, SheetsAi, SheetsAgentErrorCode } from "./ai";
export { runProposal, validateReply, writeResolved } from "./apply";
export type { AgentSession, EditScope, ProposalRecord, ValidationResult } from "./apply";
export { checkWorkbook } from "./checks";
export type { CheckOptions, Finding, FindingKind } from "./checks";
export { cleanColumn, columnRange, normaliseColumn, numberFromText, tidyText } from "./clean";
export type { AgentContext, ExplainOutcome, ProposalOutcome, SheetSelection } from "./context";
export { buildTable, editByInstruction, proposeWithModel, sheetBlocks } from "./edit";
export { cleanAnswer, explainSelection, narrateTrace } from "./explain";
export * from "./limits";
export { buildPrompt, cleanRequest, contentBudget } from "./prompt";
export type { PromptBlock, PromptParts } from "./prompt";
export { TABLE_BAND, TABLE_BODY, TABLE_HEADER, fixFinding, formatAsTable, tableRange } from "./table-format";
export { directPrecedents, traceText, traceValue } from "./trace";
export type { Trace, TraceLimits, TraceNode, TraceNodeKind } from "./trace";
export { CLOSE_MARKER, OPEN_MARKER, sanitizeMarkers, wrapUntrusted } from "./untrusted";
export { FINDINGS_LAYER, SOURCES_LAYER, SheetsAssistant } from "./assistant";
export type { AssistantDeps, AssistantGrid, AssistantMessage, AssistantState, AssistantStatusLine } from "./assistant";
export { pendingOf, resolvedStatus, snapshotProposal } from "./results";
export type { AnswerResult, AssistantResult, AssistantResultStatus, FindingsResult, ProposalResult } from "./results";
export { routeInstruction } from "./routing";
export type { AssistantIntent } from "./routing";
