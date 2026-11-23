/** Share of the checklist done, clamped to 0..1. */
export function gettingStartedFraction(completed: number, total: number): number {
  return total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
}

/** The checklist stays reachable while setup is unfinished, and while it is still open. */
export function shouldShowGettingStartedPill({ loaded, completed, total, open }: {
  loaded: boolean; completed: number; total: number; open: boolean;
}): boolean {
  return open || (loaded && completed < total);
}

/** First step the owner can act on; a step whose status is unknown only when nothing else is left. */
export function gettingStartedNextStep(rows: readonly { label: string; status: string }[]): string | null {
  return rows.find((row) => row.status === "incomplete")?.label
    ?? rows.find((row) => row.status !== "complete")?.label
    ?? null;
}
