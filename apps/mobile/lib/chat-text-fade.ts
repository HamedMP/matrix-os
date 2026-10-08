/** How long a newly shown chunk of streamed text takes to fade in. */
export const FADE_IN_MS = 350;

/** A chunk of streamed text that is still fading in. */
export interface TextFade {
  /** Offset in the message text where the chunk starts; it runs to the next fade, or to the end. */
  from: number;
  /** `Date.now()` when the chunk was first shown. */
  revealedAt: number;
}
