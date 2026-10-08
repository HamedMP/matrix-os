import { act, renderHook } from "@testing-library/react-native";

import { FADE_IN_MS } from "../lib/chat-text-fade";
import { advanceReveal, useStreamedTextReveal, type RevealState } from "../lib/streamed-text-reveal";

const START: RevealState = { cursor: 0, length: 0, fades: [] };
const SENTENCE = "The quick brown fox jumps over the lazy dog. ";

/** Ticks until the reveal stops changing, as the hook's timer would. */
function settle(state: RevealState, text: string, now: number): RevealState {
  let current = state;
  for (let tick = 0; tick < 500; tick += 1) {
    const next = advanceReveal(current, text, now);
    if (next === current) return current;
    current = next;
  }
  throw new Error("reveal never settled");
}

describe("advanceReveal", () => {
  it("shows whole words only", () => {
    const text = SENTENCE.repeat(4);
    let state = START;
    for (let tick = 0; tick < 5; tick += 1) {
      state = advanceReveal(state, text, 1_000 + tick);
      expect(text.slice(0, state.length)).toMatch(/^$|\s$/);
    }
    expect(state.length).toBeGreaterThan(0);
    expect(state.length).toBeLessThan(text.length);
  });

  it("moves faster the more text is waiting", () => {
    const short = advanceReveal(START, SENTENCE, 1_000);
    const long = advanceReveal(START, SENTENCE.repeat(20), 1_000);

    expect(long.length).toBeGreaterThan(short.length);
  });

  it("ends on the exact end of the text, including an unfinished last word", () => {
    const text = `${SENTENCE}unfinis`;

    expect(settle(START, text, 1_000).length).toBe(text.length);
  });

  it("records each newly shown chunk as a fade starting where the last one ended", () => {
    const text = SENTENCE.repeat(4);
    const first = advanceReveal(START, text, 1_000);
    const second = advanceReveal(first, text, 1_040);

    expect(first.fades).toEqual([{ from: 0, revealedAt: 1_000 }]);
    expect(second.fades).toEqual([
      { from: 0, revealedAt: 1_000 },
      { from: first.length, revealedAt: 1_040 },
    ]);
  });

  it("drops fades once they have finished", () => {
    const shown = settle(START, SENTENCE, 1_000);
    expect(shown.fades.length).toBeGreaterThan(0);

    expect(advanceReveal(shown, SENTENCE, 1_000 + FADE_IN_MS).fades).toEqual([]);
  });

  it("returns the same state when there is nothing left to show or settle", () => {
    const done: RevealState = { cursor: SENTENCE.length, length: SENTENCE.length, fades: [] };

    expect(advanceReveal(done, SENTENCE, 5_000)).toBe(done);
  });

  it("keeps what is already shown when the text gets shorter", () => {
    const shown = settle(START, SENTENCE, 1_000);

    expect(advanceReveal(shown, "The quick", 1_040).length).toBe(shown.length);
  });
});

describe("useStreamedTextReveal", () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  const advance = (ms: number) => act(() => { jest.advanceTimersByTime(ms); });

  it("shows a finished reply at once, with nothing fading and no timer running", () => {
    const { result } = renderHook(() => useStreamedTextReveal(SENTENCE, false));

    expect(result.current).toEqual({ text: SENTENCE, fades: [] });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("fades a streaming reply in from its first word, then settles on the full text", () => {
    const { result, rerender } = renderHook(
      ({ text, streaming }: { text: string; streaming: boolean }) => useStreamedTextReveal(text, streaming),
      { initialProps: { text: "The quick ", streaming: true } },
    );
    expect(result.current.text).toBe("");

    advance(200);
    expect(result.current.text).toBe("The quick ");
    expect(result.current.fades.length).toBeGreaterThan(0);

    rerender({ text: SENTENCE, streaming: true });
    advance(200);
    expect(SENTENCE.startsWith(result.current.text)).toBe(true);
    expect(result.current.text.length).toBeGreaterThan("The quick ".length);

    rerender({ text: SENTENCE, streaming: false });
    advance(2_000);
    expect(result.current).toEqual({ text: SENTENCE, fades: [] });
    expect(jest.getTimerCount()).toBe(0);
  });

  it("shows what a reply already holds when it comes into view mid-way, and animates only what follows", () => {
    const underWay = SENTENCE.repeat(4);
    const { result, rerender } = renderHook(
      ({ text }: { text: string }) => useStreamedTextReveal(text, true),
      { initialProps: { text: underWay } },
    );
    expect(result.current).toEqual({ text: underWay, fades: [] });

    rerender({ text: `${underWay}And more. ` });
    advance(40);
    expect(result.current.fades[0]?.from).toBe(underWay.length);
  });
});
