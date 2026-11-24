/**
 * Docs compare: the open document against another version.
 *
 * ```ts
 * import { compareWithFile, compareWithBytes } from "./compare";
 *
 * const result = await compareWithFile({ session, files: window.MatrixOS.files }, "Documents/contract-v2.docx");
 * if (result.status === "compared") {
 *   editor.setViewMode("markup");
 *   result.answer.headline; // "Yes. 24 changes alter the wording (1 paragraph added, 1 paragraph moved)."
 *   result.counts;          // [{ label: "Insertions", count: 11 }, …]
 * }
 * ```
 *
 * The comparison opens in the session as a new, unsaved document (the open
 * document is saved first, or the compare is `blocked`). UI: `../ui/compare`.
 */

export { COMPARE_AUTHOR, MAX_COMPARE_BYTES, answerSubstantive, compareWithBytes, compareWithFile, comparisonName, kindCounts } from "./compare";
export type { CompareDeps, CompareFailure, CompareFlowResult, KindCount, SubstantiveAnswer } from "./compare";
export type { CompareSummary } from "../../../_shared/office-engine/docx/index";
