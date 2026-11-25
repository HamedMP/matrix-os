import { type CSSProperties, type KeyboardEvent, type ReactNode, useLayoutEffect, useRef } from "react";
import { type FormulaRef, scanReferences } from "./formula-edit";

export interface FormulaInputProps {
  value: string;
  /** Caret to apply when it differs from the input's own (after a reference or a function name was inserted). */
  selectionStart: number;
  selectionEnd: number;
  /** True when this input should hold the keyboard focus. */
  focused: boolean;
  label: string;
  className?: string;
  style?: CSSProperties;
  /** Id of the function list and of its highlighted entry, when the list is open. */
  listId?: string;
  activeOptionId?: string;
  invalid?: boolean;
  onInput(text: string, selectionStart: number, selectionEnd: number): void;
  onCaret(selectionStart: number, selectionEnd: number): void;
  /** Return true when the key was handled; the default action is then prevented. */
  onKey(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
  onFocus?(): void;
  /** Receives the textarea element. */
  inputRef?: (element: HTMLTextAreaElement | null) => void;
}

/** The text split into plain parts and coloured references. */
function highlightParts(text: string, references: readonly FormulaRef[]): ReactNode[] {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const reference of references) {
    if (reference.start > at) parts.push(text.slice(at, reference.start));
    parts.push(
      <span key={reference.start} className={`sg-ref-text sg-ref-text--${reference.color}`}>
        {text.slice(reference.start, reference.end)}
      </span>,
    );
    at = reference.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/**
 * A one-line text input for cell content. While a formula is typed its
 * references are coloured: the text is drawn by a layer under a transparent
 * textarea, which keeps the caret, the selection and the keyboard.
 */
export function FormulaInput(props: FormulaInputProps) {
  const local = useRef<HTMLTextAreaElement | null>(null);
  const mirror = useRef<HTMLDivElement | null>(null);
  const references = scanReferences(props.value);
  const { value, selectionStart, selectionEnd, focused } = props;

  useLayoutEffect(() => {
    const element = local.current;
    if (element === null) return;
    if (focused && element.ownerDocument.activeElement !== element) element.focus({ preventScroll: true });
    if (focused && (element.selectionStart !== selectionStart || element.selectionEnd !== selectionEnd)) {
      element.setSelectionRange(selectionStart, selectionEnd);
    }
    if (mirror.current !== null) mirror.current.scrollLeft = element.scrollLeft;
  }, [value, selectionStart, selectionEnd, focused]);

  const setRef = (element: HTMLTextAreaElement | null): void => {
    local.current = element;
    props.inputRef?.(element);
  };

  return (
    <div className={`sg-input${props.className === undefined ? "" : ` ${props.className}`}${references.length > 0 ? " has-references" : ""}`} style={props.style}>
      <div ref={mirror} className="sg-input__mirror" aria-hidden="true">
        {references.length > 0 ? highlightParts(value, references) : value}
      </div>
      <textarea
        ref={setRef}
        className="sg-input__field"
        rows={1}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label={props.label}
        aria-invalid={props.invalid === true ? true : undefined}
        aria-autocomplete="list"
        aria-controls={props.listId}
        aria-activedescendant={props.activeOptionId}
        value={value}
        onChange={(event) => props.onInput(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
        onSelect={(event) => props.onCaret(event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
        onKeyDown={(event) => {
          if (props.onKey(event)) {
            event.preventDefault();
            event.stopPropagation();
          } else {
            // Typing belongs to this input; the grid must not read it as a command.
            event.stopPropagation();
          }
        }}
        onScroll={(event) => {
          if (mirror.current !== null) mirror.current.scrollLeft = event.currentTarget.scrollLeft;
        }}
        onFocus={props.onFocus}
      />
    </div>
  );
}
