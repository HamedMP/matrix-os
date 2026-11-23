/**
 * The contract between the Docs shell and the side panels other modules
 * supply: `./review/ReviewPanel.tsx`, `./agent/DocsAgentPanel.tsx` and
 * `./compare/ComparePanel.tsx`. Each module exports its component as the
 * default export or under its file name (`ReviewPanel`, `DocsAgentPanel`,
 * `ComparePanel`). The shell loads it lazily and shows a fallback when the
 * module is absent or fails to load.
 */

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
