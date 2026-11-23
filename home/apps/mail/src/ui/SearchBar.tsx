/**
 * The search box. Typing filters the current list at once; Enter searches
 * every account with the provider. Chips toggle common terms and show the
 * structured terms of the query.
 */
import { forwardRef, useState, type KeyboardEvent } from "react";
import { Search, X } from "lucide-react";
import { MAX_QUERY_CHARS, UNIFIED_INBOX } from "../model";
import { useMailUi } from "./context";
import { FILTER_CHIPS, isChipActive, queryTermChips, removeQueryTerm, toggleChip } from "./search-chips";

export interface SearchBarProps {
  /** True while the active list is a provider search. */
  searching: boolean;
}

export const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(function SearchBar({ searching }, ref) {
  const { store } = useMailUi();
  const [text, setText] = useState("");

  const apply = (next: string) => {
    setText(next);
    store.setFilter(next);
  };
  const clear = () => {
    setText("");
    store.setFilter("");
    if (searching) void store.openView(UNIFIED_INBOX);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void store.search(text);
    } else if (event.key === "Escape") {
      event.preventDefault();
      clear();
      event.currentTarget.blur();
    }
  };
  const terms = queryTermChips(text);

  return (
    <div role="search" aria-label="Mail search" className="mail-search">
      <div className="mail-search__box">
        <Search size={15} className="mail-search__icon" aria-hidden="true" />
        <input
          ref={ref}
          type="search"
          className="oui-input mail-search__input"
          aria-label="Search mail"
          placeholder="Search mail  (from:  subject:  has:attachment  is:unread)"
          value={text}
          maxLength={MAX_QUERY_CHARS}
          onChange={(event) => apply(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {(text || searching) && (
          <button type="button" className="oui-icon-button" aria-label="Clear search" onClick={clear}><X size={14} /></button>
        )}
      </div>
      <div className="mail-search__chips" role="group" aria-label="Filters">
        {FILTER_CHIPS.map((chip) => {
          const active = isChipActive(text, chip);
          return (
            <button
              key={chip.id}
              type="button"
              className={`oui-chip mail-chip${active ? " is-active" : ""}`}
              aria-pressed={active}
              onClick={() => apply(toggleChip(text, chip))}
            >
              {chip.label}
            </button>
          );
        })}
        {terms.map((term) => (
          <button
            key={term.token}
            type="button"
            className="oui-chip mail-chip is-active"
            aria-label={`Remove ${term.label}`}
            onClick={() => apply(removeQueryTerm(text, term.token))}
          >
            {term.label} <X size={11} aria-hidden="true" />
          </button>
        ))}
      </div>
    </div>
  );
});
