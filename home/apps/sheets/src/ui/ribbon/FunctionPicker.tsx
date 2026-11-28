/**
 * Searchable list of every function the engine calculates. Choosing one
 * puts `=NAME(` into the active cell's editor, ready for its arguments.
 */
import { type FormEvent, useMemo, useState } from "react";
import { Dialog, TextField } from "../../../../_shared/office-ui";
import { functionCount, searchFunctions } from "./function-search";

export interface FunctionPickerProps {
  open: boolean;
  onCancel: () => void;
  onInsert: (name: string) => void;
}

export function FunctionPicker({ open, onCancel, onInsert }: FunctionPickerProps) {
  const [query, setQuery] = useState("");
  const found = useMemo(() => (open ? searchFunctions(query) : []), [open, query]);
  const total = functionCount();

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const first = found[0];
    if (first !== undefined) onInsert(first.name);
  };

  return (
    <Dialog open={open} onClose={onCancel} title="Insert function" description={`${total} functions. Choose one to start it in the active cell.`} size="md">
      <form className="sheets-functions" onSubmit={submit}>
        <TextField label="Search functions" value={query} onChange={setQuery} placeholder="SUM, lookup, date…" autoFocus maxLength={60} />
        {found.length === 0 ? (
          <p className="sheets-functions__empty" role="status">
            No function matches “{query.trim()}”.
          </p>
        ) : (
          <ul className="sheets-functions__list" aria-label="Functions">
            {found.map((hint) => (
              <li key={hint.name}>
                <button type="button" className="sheets-functions__item" onClick={() => onInsert(hint.name)}>
                  <span className="sheets-functions__name">
                    {hint.name}({hint.args.join(", ")})
                  </span>
                  {hint.summary !== "" && <span className="sheets-functions__summary">{hint.summary}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </form>
    </Dialog>
  );
}
