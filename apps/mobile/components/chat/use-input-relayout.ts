import { useCallback, useLayoutEffect, useRef, useState } from "react";

// Too small to change a drawn pixel, enough to count as a new layout.
const RELAYOUT_NUDGE = 0.01;

/**
 * Keeps a growing multiline input as tall as its text when the text comes
 * from the app rather than the keyboard: dictation, a suggestion, a draft
 * put back.
 *
 * React Native measures a TextInput against the text of its previous layout
 * and only takes in new text afterwards (`BaseTextInputShadowNode` measures
 * from state that its `layout()` updates). Text set from code therefore keeps
 * the old height until the input is laid out again, as a tap on it would do.
 * After such a change this lays it out once more, through a style difference
 * no one can see.
 *
 * Returns the handler to give the input's `onChangeText` and the extra
 * minimum height to add to its style.
 */
export function useInputRelayout(text: string, onChangeText: (text: string) => void) {
  // The last text the person typed, so their own typing is not laid out twice.
  const typed = useRef(text);
  const [passes, setPasses] = useState(0);

  useLayoutEffect(() => {
    if (text === typed.current) return;
    typed.current = text;
    // The second layout pass is the point: it has to follow the commit that
    // measured the input, and a layout effect runs it before the frame is drawn.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPasses((current) => current + 1);
  }, [text]);

  const handleChangeText = useCallback((next: string) => {
    typed.current = next;
    onChangeText(next);
  }, [onChangeText]);

  return { handleChangeText, minHeightNudge: passes % 2 === 0 ? 0 : RELAYOUT_NUDGE };
}
