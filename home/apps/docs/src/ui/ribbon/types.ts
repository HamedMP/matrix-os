/**
 * The contract between the Docs workspace and its ribbon. `buildDocsRibbon`
 * (`./index.ts`) is a pure function of this context: every ribbon command
 * calls exactly one of `DocsRibbonActions`, and the workspace
 * (`./use-docs-ribbon.ts`) implements each one with the editor, session,
 * review controller and panels.
 */

import type { ParagraphStylePatch, RunFormat } from "../../../../_shared/office-engine/index";
import type { ActiveFormat, ViewMode } from "../../editor/index";
import type { DocumentSource } from "../../session/index";
import type { ExportFormat } from "../exports";
import type { AssistantRequestId, DocsPanelId } from "../panel-types";
import type { CaretFormat } from "./caret-format";
import type { StyleChoice } from "./styles-model";

export interface DocsRibbonState {
  /** The editor is mounted. */
  hasEditor: boolean;
  /** The editor accepts edits (mounted and not in the read-only original view). */
  editable: boolean;
  /** The selection is not collapsed. */
  hasSelection: boolean;
  canUndo: boolean;
  canRedo: boolean;
  format: ActiveFormat | null;
  caret: CaretFormat | null;
  styles: readonly StyleChoice[];
  tracking: boolean;
  viewMode: ViewMode;
  /** Pending revisions, and those the review filter shows. */
  revisions: { total: number; shown: number };
  zoom: number;
  findOpen: boolean;
  outlineOpen: boolean;
  panel: DocsPanelId | null;
  source: DocumentSource;
  /** The document has a path in the home. */
  hasPath: boolean;
  saving: boolean;
  /** The colour each colour button applies with its face: the one chosen last (null removes the colour). */
  colors: { font: string | null; highlight: string | null };
}

export type ToggleableFormat = "bold" | "italic" | "underline" | "strike";

export interface DocsRibbonActions {
  // File
  newBlank(): void;
  newFromMarkdown(): void;
  openFromMatrix(): void;
  openFromComputer(): void;
  save(): void;
  /** Save a copy in the home (for a local document: Save a copy to Matrix). */
  saveCopy(): void;
  downloadCopy(): void;
  exportAs(format: ExportFormat): void;
  close(): void;
  // Home
  undo(): void;
  redo(): void;
  cut(): void;
  copy(): void;
  paste(): void;
  toggleFormat(format: ToggleableFormat): void;
  setRunFormat(patch: Partial<RunFormat>): void;
  /** Colours the selection and makes the colour the one its button applies next; null is automatic. */
  setFontColor(color: string | null): void;
  /** Highlights the selection; null removes the highlight. */
  setHighlight(color: string | null): void;
  setParagraphStyle(patch: Partial<ParagraphStylePatch>): void;
  applyStyle(id: string): void;
  openFind(): void;
  toggleFind(): void;
  // Insert
  insertText(text: "\n" | "\t"): void;
  insertParagraph(): void;
  insertTableRow(where: "above" | "below"): void;
  deleteTableRow(): void;
  /** Opens the Review panel with the comment box focused, on the selection. */
  newComment(): void;
  // Review
  setTracking(enabled: boolean): void;
  setViewMode(mode: ViewMode): void;
  previousChange(): void;
  nextChange(): void;
  acceptChange(): void;
  rejectChange(): void;
  acceptAll(): void;
  rejectAll(): void;
  openPanel(id: DocsPanelId): void;
  // View
  setZoom(zoom: number): void;
  toggleOutline(): void;
  togglePanel(): void;
  // Assistant
  assistant(request: AssistantRequestId): void;
}

export interface DocsRibbonContext {
  state: DocsRibbonState;
  actions: DocsRibbonActions;
}
