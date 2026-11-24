/**
 * Review UI for the Sheets app.
 *
 * ```tsx
 * const review = useMemo(() => new SheetReviewController(session, grid), [session, grid]);
 * useEffect(() => () => review.dispose(), [review]);
 * <AppFrame banner={<SheetReviewBar review={review} />} rightPanel={<SheetReviewPanel review={review} gridElement={gridRoot} />}>
 * ```
 *
 * `gridElement` is the grid's root (`.sheet-grid`); markup draws each old
 * value struck through before the new one there.
 */

export { MAX_ROWS_PER_GROUP, SheetReviewBar, SheetReviewPanel } from "./SheetReviewPanel";
export type { SheetReviewPanelProps } from "./SheetReviewPanel";
export { ChangeRow } from "./ChangeRow";
export { MARKUP_ATTRIBUTE, MARKUP_ROOT_CLASS, applyMarkup, useMarkupOverlay } from "./markup-overlay";
export { useMarkupMap, useReviewState } from "./use-review";
