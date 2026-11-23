/**
 * The composer's rich-text body: a contenteditable region whose input is
 * filtered through `beforeinput` to a small command set (typing, deleting,
 * line breaks, bold, italic, underline, lists, links, quote). Paste is
 * sanitised; drops and every other formatting command are refused.
 *
 * The region shows the redline markup when changes are pending. Deletions
 * are read-only, and on each input the content without deletions (the final
 * text) is reported to the parent, which re-renders the markup; the caret
 * is kept in place across re-renders.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { editorMarkup } from "../../compose/redline-body";
import { captureCaret, restoreCaret } from "../../compose/caret";
import { pastedTextToHtml, sanitizePastedHtml } from "../../compose/paste";

/** Input types the editor lets the browser carry out. */
const ALLOWED_INPUT = new Set([
  "insertText", "insertReplacementText", "insertLineBreak", "insertParagraph", "insertCompositionText",
  "deleteContentBackward", "deleteContentForward", "deleteWordBackward", "deleteWordForward",
  "deleteSoftLineBackward", "deleteSoftLineForward", "deleteHardLineBackward", "deleteHardLineForward",
  "deleteByCut", "deleteContent", "deleteEntireSoftLine",
  "formatBold", "formatItalic", "formatUnderline", "insertOrderedList", "insertUnorderedList",
  "formatIndent", "formatOutdent", "insertLink", "formatBlock",
]);

export type EditorCommand = "bold" | "italic" | "underline" | "bulletList" | "numberedList" | "quote";

export interface RichEditorHandle {
  focus(): void;
  run(command: EditorCommand): void;
  /** Turns the selection into a link to `url` (already validated). */
  link(url: string): void;
  /** True when the selection is inside the editor and not collapsed. */
  hasSelection(): boolean;
}

export interface RichEditorProps {
  label: string;
  markup: string;
  renderKey: number;
  onInput(finalHtml: string): void;
  onUndo(): void;
  onRedo(): void;
  /** Ctrl/Cmd+Enter. */
  onSendShortcut(): void;
  /** Ctrl/Cmd+K. */
  onLinkShortcut(): void;
  currentChangeId: string | null;
  disabled?: boolean;
}

/** The editor's content without deletions and with insertions unwrapped. */
export function finalHtmlOf(root: HTMLElement): string {
  const copy = root.cloneNode(true) as HTMLElement;
  for (const del of Array.from(copy.querySelectorAll("del"))) del.remove();
  for (const ins of Array.from(copy.querySelectorAll("ins"))) ins.replaceWith(...Array.from(ins.childNodes));
  return copy.innerHTML;
}

function exec(command: string, value?: string): void {
  // execCommand keeps the browser's own selection handling and IME behaviour.
  if (typeof document.execCommand === "function") document.execCommand(command, false, value);
}

function closestBlockquote(root: HTMLElement): boolean {
  const node = document.getSelection()?.anchorNode ?? null;
  for (let current: Node | null = node; current && current !== root; current = current.parentNode) {
    if (current.nodeType === 1 && (current as Element).tagName === "BLOCKQUOTE") return true;
  }
  return false;
}

export const RichEditor = forwardRef<RichEditorHandle, RichEditorProps>(function RichEditor(
  { label, markup, renderKey, onInput, onUndo, onRedo, onSendShortcut, onLinkShortcut, currentChangeId, disabled = false },
  ref,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const handlers = useRef({ onInput, onUndo, onRedo, onSendShortcut, onLinkShortcut });
  const markupRef = useRef(markup);
  // Latest props for the DOM listeners and the markup effect below; runs before that effect.
  useLayoutEffect(() => {
    handlers.current = { onInput, onUndo, onRedo, onSendShortcut, onLinkShortcut };
    markupRef.current = markup;
  });

  useImperativeHandle(ref, () => ({
    focus: () => rootRef.current?.focus(),
    run(command) {
      const root = rootRef.current;
      if (!root) return;
      root.focus();
      if (command === "bold") exec("bold");
      else if (command === "italic") exec("italic");
      else if (command === "underline") exec("underline");
      else if (command === "bulletList") exec("insertUnorderedList");
      else if (command === "numberedList") exec("insertOrderedList");
      else exec("formatBlock", closestBlockquote(root) ? "div" : "blockquote");
    },
    link(url) {
      rootRef.current?.focus();
      exec("createLink", url);
    },
    hasSelection() {
      const selection = document.getSelection();
      const root = rootRef.current;
      return Boolean(root && selection && !selection.isCollapsed && selection.anchorNode && root.contains(selection.anchorNode));
    },
  }), []);

  // Apply the markup to the DOM when the parent asks for it; keep the caret.
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const focused = root.ownerDocument.activeElement === root;
    const caret = focused ? captureCaret(root) : null;
    root.innerHTML = editorMarkup(markupRef.current);
    if (caret !== null) restoreCaret(root, caret);
  }, [renderKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const element of Array.from(root.querySelectorAll(".mail-compose__change--current"))) element.classList.remove("mail-compose__change--current");
    if (!currentChangeId) return;
    const marks = Array.from(root.querySelectorAll("ins[data-change-id], del[data-change-id]")).filter((element) => element.getAttribute("data-change-id") === currentChangeId);
    for (const element of marks) element.classList.add("mail-compose__change--current");
    marks[0]?.scrollIntoView?.({ block: "nearest" });
  }, [currentChangeId, renderKey]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const emit = () => handlers.current.onInput(finalHtmlOf(root));
    const onBeforeInput = (event: InputEvent) => {
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        if (event.inputType === "historyUndo") handlers.current.onUndo();
        else handlers.current.onRedo();
        return;
      }
      if (!ALLOWED_INPUT.has(event.inputType)) event.preventDefault();
    };
    const onInputEvent = (event: Event) => {
      if (composing.current || (event as InputEvent).isComposing) return;
      emit();
    };
    const onCompositionStart = () => {
      composing.current = true;
    };
    const onCompositionEnd = () => {
      composing.current = false;
      emit();
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const data = event.clipboardData;
      if (!data) return;
      const html = data.getData("text/html");
      const safe = html ? sanitizePastedHtml(html) : pastedTextToHtml(data.getData("text/plain"));
      if (safe) exec("insertHTML", safe);
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      if (event.key === "Enter") {
        event.preventDefault();
        handlers.current.onSendShortcut();
      } else if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        handlers.current.onLinkShortcut();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) handlers.current.onRedo();
        else handlers.current.onUndo();
      } else if (event.key.toLowerCase() === "y") {
        event.preventDefault();
        handlers.current.onRedo();
      }
    };
    root.addEventListener("beforeinput", onBeforeInput);
    root.addEventListener("input", onInputEvent);
    root.addEventListener("compositionstart", onCompositionStart);
    root.addEventListener("compositionend", onCompositionEnd);
    root.addEventListener("paste", onPaste);
    root.addEventListener("drop", onDrop);
    root.addEventListener("keydown", onKeyDown);
    exec("defaultParagraphSeparator", "div");
    return () => {
      root.removeEventListener("beforeinput", onBeforeInput);
      root.removeEventListener("input", onInputEvent);
      root.removeEventListener("compositionstart", onCompositionStart);
      root.removeEventListener("compositionend", onCompositionEnd);
      root.removeEventListener("paste", onPaste);
      root.removeEventListener("drop", onDrop);
      root.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div
      ref={rootRef}
      className="mail-compose__editor"
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={label}
      aria-disabled={disabled || undefined}
      spellCheck
      data-mail-keys="off"
    />
  );
});
