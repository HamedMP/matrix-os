import { act, waitFor } from "@testing-library/react";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  getNearestEditorFromDOMNode,
} from "lexical";

// Lexical scrolls a focused collapsed selection into view. jsdom implements
// Range but not its layout measurement API, so provide the zero-layout result
// that the rest of the test environment already assumes.
if (!("getBoundingClientRect" in Range.prototype)) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => document.createElement("span").getBoundingClientRect(),
  });
}

export async function setSharedComposerText(composer: HTMLElement, value: string) {
  const editor = getNearestEditorFromDOMNode(composer);
  if (!editor) throw new Error("Expected a Lexical chat composer");
  await act(async () => {
    editor.update(() => {
      const paragraph = $createParagraphNode();
      if (value) paragraph.append($createTextNode(value));
      $getRoot().clear().append(paragraph);
      paragraph.selectEnd();
    }, { discrete: true });
  });
  await waitFor(() => {
    if (composer.textContent !== value) {
      throw new Error(`Expected composer text ${JSON.stringify(value)}, received ${JSON.stringify(composer.textContent)}`);
    }
  });
}

export async function appendSharedComposerText(composer: HTMLElement, value: string) {
  const editor = getNearestEditorFromDOMNode(composer);
  if (!editor) throw new Error("Expected a Lexical chat composer");
  await act(async () => {
    editor.update(() => {
      $getRoot().selectEnd();
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
      selection.insertText(value);
    }, { discrete: true });
  });
}
