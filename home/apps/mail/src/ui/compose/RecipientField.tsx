/**
 * One recipient line (To, Cc or Bcc): chips for the addresses, red chips for
 * entries that are not usable addresses, a text input, and suggestions from
 * addresses seen in the cache. The parent owns the addresses (they live in
 * the draft) and the typed text, so it can commit everything before Send.
 */
import { useId, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import { formatMailAddress, type MailAddress } from "../../../../_shared/office-accounts/types/mail";
import { suggestAddresses } from "../../compose/address-book";

export interface RecipientFieldProps {
  label: string;
  addresses: readonly MailAddress[];
  /** Entries that could not be read as an address. */
  invalid: readonly string[];
  text: string;
  book: readonly MailAddress[];
  onText(text: string): void;
  /** Turns typed text into chips: all of it (Enter, blur) or up to the last separator. */
  onCommit(text: string, all: boolean): void;
  onAdd(address: MailAddress): void;
  onRemove(address: string): void;
  onRemoveInvalid(entry: string): void;
  autoFocus?: boolean;
}

export function RecipientField({
  label, addresses, invalid, text, book, onText, onCommit, onAdd, onRemove, onRemoveInvalid, autoFocus,
}: RecipientFieldProps) {
  const id = useId();
  const listId = `${id}-suggestions`;
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const suggestions = open ? suggestAddresses(book, text, addresses) : [];
  const highlighted = suggestions.length ? Math.min(active, suggestions.length - 1) : -1;

  const choose = (entry: MailAddress) => {
    onAdd(entry);
    onText("");
    setOpen(false);
    setActive(0);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" && suggestions.length) {
      event.preventDefault();
      setActive((highlighted + 1) % suggestions.length);
    } else if (event.key === "ArrowUp" && suggestions.length) {
      event.preventDefault();
      setActive((highlighted - 1 + suggestions.length) % suggestions.length);
    } else if ((event.key === "Enter" || event.key === "Tab") && highlighted >= 0) {
      event.preventDefault();
      choose(suggestions[highlighted]);
    } else if (event.key === "Enter" && text.trim()) {
      event.preventDefault();
      onCommit(text, true);
    } else if (event.key === "Escape" && open && suggestions.length) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "Backspace" && !text) {
      if (invalid.length) onRemoveInvalid(invalid[invalid.length - 1]);
      else if (addresses.length) onRemove(addresses[addresses.length - 1].address);
    }
  };

  return (
    <div className="mail-compose__recipients">
      <label className="mail-compose__label" htmlFor={id}>{label}</label>
      <div className="mail-compose__chips">
        {addresses.map((entry) => (
          <span key={entry.address} className="mail-compose__chip" title={entry.address}>
            <span className="mail-compose__chip-text">{entry.name || entry.address}</span>
            <button type="button" className="mail-compose__chip-remove" aria-label={`Remove ${formatMailAddress(entry)}`} onClick={() => onRemove(entry.address)}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        {invalid.map((entry) => (
          <span key={`invalid-${entry}`} className="mail-compose__chip mail-compose__chip--invalid" title="Not a valid address">
            <span className="mail-compose__chip-text">{entry}</span>
            <button type="button" className="mail-compose__chip-remove" aria-label={`Remove ${entry}`} onClick={() => onRemoveInvalid(entry)}>
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          className="mail-compose__recipient-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          value={text}
          role="combobox"
          aria-expanded={suggestions.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={highlighted >= 0 ? `${listId}-${highlighted}` : undefined}
          aria-invalid={invalid.length > 0 || undefined}
          onChange={(event) => {
            const value = event.target.value;
            setOpen(true);
            setActive(0);
            if (/[,;\n]/.test(value)) onCommit(value, false);
            else onText(value);
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData("text/plain");
            if (/[,;\n]/.test(pasted)) {
              event.preventDefault();
              onCommit(`${text}${pasted}`, false);
            }
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setOpen(false);
            if (text.trim()) onCommit(text, true);
          }}
        />
      </div>
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" aria-label={`${label} suggestions`} className="mail-compose__suggestions">
          {suggestions.map((entry, index) => (
            <li
              key={entry.address}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === highlighted}
              className={index === highlighted ? "mail-compose__suggestion mail-compose__suggestion--active" : "mail-compose__suggestion"}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(entry);
              }}
            >
              {entry.name && <span className="mail-compose__suggestion-name">{entry.name}</span>}
              <span className="mail-compose__suggestion-address">{entry.address}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
