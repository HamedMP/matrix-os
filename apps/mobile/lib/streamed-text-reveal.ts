import { useEffect, useRef, useState } from "react";

import { FADE_IN_MS, type TextFade } from "@/lib/chat-text-fade";

// Text arrives from the network in uneven bursts. Showing it the moment it
// lands would make the fade stutter, so it is revealed on a steady tick that
// trails the stream slightly instead.
const TICK_MS = 40;
// Each tick shows this share of the waiting text, so the reveal settles about
// this far behind the stream however fast the stream is.
const CATCH_UP_MS = 400;
const MIN_CHARS_PER_TICK = 4;
// A reply shorter than this when it first appears has only just begun.
const JUST_BEGUN_CHARS = 120;
// Beyond this, stop waiting for a space: the text is written without them.
const LONGEST_WORD_CHARS = 40;
const WHITESPACE = /\s/;

export interface RevealState {
  /** How far the reveal has advanced, in characters; fractional between ticks. */
  cursor: number;
  /** How many characters are shown: `cursor` pulled back to the last whole word. */
  length: number;
  /** Recently shown chunks that are still fading in, oldest first. */
  fades: TextFade[];
}

/** The end of the last complete word at or before `cursor`, so words never appear in pieces. */
function lastWholeWordEnd(text: string, cursor: number): number {
  const end = Math.min(Math.floor(cursor), text.length);
  const earliest = Math.max(0, end - LONGEST_WORD_CHARS);
  for (let index = end; index > earliest; index -= 1) {
    if (WHITESPACE.test(text[index - 1]!)) return index;
  }
  // No space in reach: still inside the very first word, or text without spaces.
  return earliest === 0 ? 0 : end;
}

/** One tick of the reveal: shows the next chunk of `text` and retires finished fades. */
export function advanceReveal(current: RevealState, text: string, now: number): RevealState {
  const isFading = (fade: TextFade) => now - fade.revealedAt < FADE_IN_MS;
  const fades = current.fades.every(isFading) ? current.fades : current.fades.filter(isFading);

  // Speed scales with how much text is waiting: a burst catches up quickly,
  // a trickle stays even.
  const waiting = text.length - current.cursor;
  const step = Math.max(MIN_CHARS_PER_TICK, waiting * (TICK_MS / CATCH_UP_MS));
  const cursor = Math.min(text.length, current.cursor + step);
  const length = cursor >= text.length ? text.length : lastWholeWordEnd(text, cursor);

  if (length > current.length) {
    return { cursor, length, fades: [...fades, { from: current.length, revealedAt: now }] };
  }
  // Returning the same object lets React skip the re-render while idle.
  return cursor === current.cursor && fades === current.fades ? current : { ...current, cursor, fades };
}

/**
 * Paces a streamed reply for display: returns the part of `text` to show right
 * now and which of its chunks are still fading in.
 */
export function useStreamedTextReveal(text: string, streaming: boolean): { text: string; fades: TextFade[] } {
  // A reply that has only just begun fades in from its first word. Anything
  // already on hand when the message comes into view -- a finished reply, or
  // one opened or scrolled back to mid-way -- is shown as is, and only the
  // text that arrives afterwards is paced and faded.
  const [reveal, setReveal] = useState<RevealState>(() => {
    const length = streaming && text.length <= JUST_BEGUN_CHARS ? 0 : text.length;
    return { cursor: length, length, fades: [] };
  });
  // The timer below must not restart on every text update, so it reads the
  // text through a ref.
  const latestText = useRef(text);
  useEffect(() => {
    latestText.current = text;
  }, [text]);

  const animating = reveal.length < text.length || reveal.fades.length > 0;
  useEffect(() => {
    if (!animating) return;
    const timer = setInterval(() => {
      const now = Date.now();
      const latest = latestText.current;
      setReveal((current) => advanceReveal(current, latest, now));
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [animating]);

  return { text: text.slice(0, reveal.length), fades: reveal.fades };
}
