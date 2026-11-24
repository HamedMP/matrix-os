/**
 * The contract between the Docs shell and its side panels: the Review tab
 * (`./ReviewIntegration.tsx`), `./agent/DocsAgentPanel.tsx` and
 * `./compare/ComparePanel.tsx`. The Assistant and Compare modules export
 * their component as the default export; `./SidePanels.tsx` loads them
 * lazily and shows a fallback when one fails to load or render.
 */

import type { QuickActionId } from "../agent/quick-actions";
import type { DocumentEditorController } from "../editor/index";
import type { DocumentSession } from "../session/index";

export interface DocsPanelProps {
  /** The open document. Edits go through it (`apply`, `acceptRevisions`, ...). */
  session: DocumentSession;
  /** The mounted editor, for selection, scrolling and highlights; null for a moment while it mounts. */
  editor: DocumentEditorController | null;
  /** Asks the owner to choose a `.docx` in their home with the Open dialog. Resolves null when cancelled. */
  pickDocument: (options?: { title?: string }) => Promise<string | null>;
  /** Closes the side panel. */
  onClose: () => void;
}

export type DocsPanelId = "review" | "assistant" | "compare";

/** What the ribbon asks the Assistant panel to run: a quick action, Explain selection or Fix numbering. */
export type AssistantRequestId = QuickActionId | "explain" | "fix-numbering";

/** One request; a new object is a new request. The panel reports it handled so it runs once. */
export interface AssistantRequest {
  id: AssistantRequestId;
}
