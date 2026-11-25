import type { FunctionHint } from "./function-hints";
import { optionId } from "./render-model";

export interface FunctionPopupProps {
  /** Id of the list element, referenced by the input's `aria-controls`. */
  listId: string;
  /** Function names to offer; empty hides the list. */
  items: readonly string[];
  activeIndex: number;
  /** One-line summaries by function name. */
  summaryOf(name: string): string;
  /** The call the caret is in, with the index of its current argument; null hides the hint. */
  hint: { hint: FunctionHint; active: number } | null;
  left: number;
  top: number;
  onPick(name: string): void;
}

/** The function list and the argument hint shown under the text being edited. */
export function FunctionPopup({ listId, items, activeIndex, summaryOf, hint, left, top, onPick }: FunctionPopupProps) {
  if (items.length === 0 && hint === null) return null;
  return (
    <div className="sg-popup" style={{ left, top }}>
      {items.length > 0 ? (
        <ul id={listId} role="listbox" aria-label="Functions" className="sg-popup__list">
          {items.map((name, index) => (
            <li
              key={name}
              id={optionId(listId, index)}
              role="option"
              aria-selected={index === activeIndex}
              className={`sg-popup__option${index === activeIndex ? " is-active" : ""}`}
              // The mouse must not take the focus from the editor.
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(name);
              }}
            >
              <span className="sg-popup__name">{name}</span>
              <span className="sg-popup__summary">{summaryOf(name)}</span>
            </li>
          ))}
        </ul>
      ) : hint !== null ? (
        <div className="sg-popup__hint" role="status">
          <span className="sg-popup__name">{hint.hint.name}</span>(
          {hint.hint.args.map((arg, index) => (
            <span key={arg}>
              {index > 0 ? ", " : ""}
              <span className={index === hint.active ? "sg-popup__arg is-active" : "sg-popup__arg"}>{arg}</span>
            </span>
          ))}
          ){hint.hint.summary === "" ? null : <span className="sg-popup__summary"> {hint.hint.summary}</span>}
        </div>
      ) : null}
    </div>
  );
}
