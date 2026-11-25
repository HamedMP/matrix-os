/**
 * The composer's draft while a send shows its pending message. The draft
 * leaves the composer when the pending message shows (so the owner never sees
 * it twice), comes back if the send is not admitted, and settles once the
 * server accepts it. Each step runs at most once per phase:
 *
 * - `clear` empties the composer and returns false when the composer no
 *   longer holds this send's draft (the owner moved on); nothing is restored then.
 * - `restore` puts the draft back; it must leave a draft the owner wrote since alone.
 * - `settle(cleared)` finishes an admitted send; `cleared` says whether the
 *   draft already left the composer, otherwise it still has to be cleared.
 *
 * A send that was restored can still be accepted later (an unconfirmed
 * admission that is then confirmed): it settles with `cleared` false.
 */
export function createComposerSendHandoff(steps: {
  clear(): boolean;
  restore(): void;
  settle(cleared: boolean): void;
}) {
  let phase: "draft" | "cleared" | "kept" | "settled" = "draft";
  return {
    /** The pending message is visible: the composer lets the draft go. */
    shown() {
      if (phase !== "draft") return;
      phase = steps.clear() ? "cleared" : "kept";
    },
    /** The server admitted the send. */
    accepted() {
      if (phase === "settled") return;
      const cleared = phase === "cleared";
      phase = "settled";
      steps.settle(cleared);
    },
    /** The send ended without admission: the draft comes back to retry. */
    rejected() {
      if (phase !== "cleared") return;
      phase = "kept";
      steps.restore();
    },
  };
}
