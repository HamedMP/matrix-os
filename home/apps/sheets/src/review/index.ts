/**
 * Change review for the Sheets app.
 *
 * ```ts
 * import { SheetReviewController } from "./review";
 *
 * const review = new SheetReviewController(session, gridController);
 * review.subscribe(() => setState(review.getState()));
 * review.next();                 // selects the first changed cell on the grid
 * review.acceptCurrent();        // or rejectCurrent(), accept("selection"), reject("all")
 * review.setMarkup(true);        // decorates changed cells with old and new values
 * review.dispose();
 * ```
 *
 * The list comes from the engine's change journal (`listJournalChanges`),
 * grouped by proposal. Accepting or rejecting goes through the session, which
 * recalculates the workbook straight after. The UI is `SheetReviewPanel` in
 * `../ui/review`.
 */

export { MARKUP_LAYER, SheetReviewController } from "./controller";
export type { ReviewActionResult, ReviewGrid, ReviewSession, ReviewState, ReviewTarget } from "./controller";
export { buildReviewGroups, markupDecorations, markupOldText, markupOldTextById, reviewOrder } from "./model";
export type { ReviewGroup, ReviewItem } from "./model";
