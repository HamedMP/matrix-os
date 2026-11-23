/**
 * The Mail app's agent features. Pure orchestration over `MatrixOS.ai.generate`
 * and the Mail store; no React here (the panel is in `../ui/agent`).
 *
 * ## Wiring
 *
 *   import { bridgeMailAi, createMailAgent, createMailAgentContext } from "./agent";
 *   const ai = bridgeMailAi();                       // null when the host has no AI
 *   const agent = ai && createMailAgent(createMailAgentContext({
 *     ai, store, providerFor: (accountId) => providers[accountId],
 *   }));
 *   <MailAgentPanel agent={agent} store={store} />
 *
 * The composer shows an agent draft for review with
 * `agent.context.proposals.forDraft(draftLocalId)` (`original` vs `proposed`)
 * and calls `agent.keepDraft(id)` / `agent.discardDraft(id)`.
 *
 * ## Safety
 *
 * - Mail content and pasted rows reach the model only inside untrusted
 *   markers (`untrusted.ts`); prompts stay under 32,000 characters.
 * - Replies are parsed defensively with one repair pass; failures are
 *   `MailAgentError` with a fixed owner-facing sentence.
 * - Nothing here sends mail, except `BulkDrafts.confirmSend(token)`, which
 *   needs the token of a send request the owner confirmed in ConfirmSend.
 * - The voice cache needs the `mail_voice_profiles` table in matrix.json
 *   (see `voice-cache.ts`); without it profiles stay in memory.
 */
export { bridgeMailAi, generateJson, type MailAi, type Validator } from "./ai";
export { createMailAgent, type MailAgent, type MailAgentState, type PanelItem, type PanelMessage, type PanelStatusLine } from "./controller";
export { createMailAgentContext, type MailAgentContext, type MailAgentContextOptions } from "./context";
export { MAIL_AGENT_ERROR_MESSAGES, MailAgentError, isMailAgentError, type MailAgentErrorCode } from "./errors";
export { discardProposal, draftNew, draftReply, keepProposal } from "./drafting";
export { createProposalRegistry, type DraftProposal, type ProposalRegistry } from "./proposals";
export { summarizeThread, type ThreadDigest } from "./summarize";
export { agenticSearch, openSearchResult, type AgenticSearchResult, type RankedThread } from "./search";
export { planQueries, type SearchHints, type SearchStrategy } from "./search-plan";
export { applyTriageSuggestions, suggestTriage, type TriageAction, type TriageSuggestion } from "./triage";
export { createBulkDrafts, type BulkDrafts } from "./bulk";
export { parseTable, recipientColumn, tableFromRows, type BulkTable } from "./bulk-rows";
export { bulkCounts, type BulkRow, type BulkRowStatus, type BulkState, type SendRequest } from "./bulk-state";
export { loadVoiceProfile } from "./voice";
export { deriveVoiceProfile, type VoiceProfile } from "./voice-derive";
export { VOICE_TABLE, createVoiceProfileCache, type VoiceProfileCache } from "./voice-cache";
export { routeIntent, type MailIntent, type MailIntentKind } from "./intent";
export * from "./limits";
