import { useMemo, useSyncExternalStore } from "react";
import { type ReviewState, type SheetReviewController, markupOldTextById } from "../../review";

/** The controller's state, re-rendering on every change. */
export function useReviewState(review: SheetReviewController): ReviewState {
  return useSyncExternalStore(
    (listener) => review.subscribe(listener),
    () => review.getState(),
    () => review.getState(),
  );
}

/** Old text by change id while markup is on, else null. Stable while the list does not change. */
export function useMarkupMap(state: ReviewState): ReadonlyMap<string, string> | null {
  const { markup, items } = state;
  return useMemo(() => (markup ? markupOldTextById(items) : null), [markup, items]);
}
