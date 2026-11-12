import { act, waitFor } from "@testing-library/react";
import { vi } from "vitest";
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

// Floating UI uses the viewport and the anchor rectangle to decide when the menu is clipped.
export function mockSharedComposerPopoverLayout() {
  const width = vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(900);
  const height = vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(700);
  const getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return this.dataset.slot === "shared-chat-composer"
      ? new DOMRect(24, 96, 600, 120)
      : getBoundingClientRect.call(this);
  });
  return () => {
    rect.mockRestore();
    height.mockRestore();
    width.mockRestore();
  };
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

export async function insertSharedComposerTextAtSelection(composer: HTMLElement, value: string) {
  const editor = getNearestEditorFromDOMNode(composer);
  if (!editor) throw new Error("Expected a Lexical chat composer");
  await act(async () => {
    editor.update(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) throw new Error("Expected a range selection");
      selection.insertText(value);
    }, { discrete: true });
  });
}
