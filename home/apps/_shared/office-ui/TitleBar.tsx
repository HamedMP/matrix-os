import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./internal";

export interface BackToHomeProps {
  /** App name shown next to the arrow, e.g. "Docs". */
  label: string;
  onClick: () => void;
  /** Accessible name and tooltip (default "Back to {label} home"). */
  ariaLabel?: string;
  className?: string;
}

/** Arrow plus app name that returns from a document to the app's home screen. */
export function BackToHome({ label, onClick, ariaLabel, className }: BackToHomeProps) {
  const name = ariaLabel ?? `Back to ${label} home`;
  return (
    <button type="button" className={cx("oui-back-home", className)} aria-label={name} title={name} onClick={onClick}>
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="oui-back-home__label">{label}</span>
    </button>
  );
}

export type SaveState = "saved" | "saving" | "unsaved" | "error" | "offline";

const SAVE_TEXT: Record<SaveState, string> = {
  saved: "Saved",
  saving: "Saving…",
  unsaved: "Unsaved changes",
  error: "Not saved",
  offline: "Offline",
};

export interface DocumentTitleBarProps {
  /** App name for the back button. */
  appName: string;
  /** Return to the app home (document list). */
  onHome: () => void;
  /** Document name. */
  name: string;
  /** When given, clicking the name renames it. Receives the trimmed, changed name. */
  onRename?: (name: string) => void;
  maxNameLength?: number;
  saveState?: SaveState;
  /** Overrides the default save-state text, e.g. "Saved 2 minutes ago". */
  saveLabel?: string;
  /** Small element between the back button and the name, such as a file icon. */
  leading?: ReactNode;
  /** Trailing actions: share, account, agent toggle. */
  actions?: ReactNode;
  className?: string;
}

/** Title row for an open document: back to home, name (renamable), save state and actions. */
export function DocumentTitleBar({
  appName,
  onHome,
  name,
  onRename,
  maxNameLength = 255,
  saveState,
  saveLabel,
  leading,
  actions,
  className,
}: DocumentTitleBarProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const nameButtonRef = useRef<HTMLButtonElement>(null);
  const refocusName = useRef(false);
  // Guards against a second commit from the blur that follows Enter or Escape.
  const editingRef = useRef(false);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    } else if (refocusName.current) {
      refocusName.current = false;
      nameButtonRef.current?.focus();
    }
  }, [editing]);

  const startEditing = () => {
    setDraft(name);
    editingRef.current = true;
    setEditing(true);
  };
  const finish = (commit: boolean) => {
    if (!editingRef.current) return;
    editingRef.current = false;
    const next = draft.trim();
    refocusName.current = true;
    setEditing(false);
    if (commit && onRename && next && next !== name) onRename(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  const status = saveLabel ?? (saveState ? SAVE_TEXT[saveState] : null);

  return (
    <div className={cx("oui-doc-title", className)}>
      <BackToHome label={appName} onClick={onHome} />
      <span className="oui-doc-title__divider" aria-hidden="true" />
      {leading && <span className="oui-doc-title__leading" aria-hidden="true">{leading}</span>}
      <h1 className="oui-doc-title__heading" aria-label={name}>
        {editing ? (
          <input
            ref={inputRef}
            className="oui-input oui-doc-title__input"
            aria-label="Document name"
            value={draft}
            maxLength={maxNameLength}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => finish(true)}
          />
        ) : onRename ? (
          <button ref={nameButtonRef} type="button" className="oui-doc-title__name is-editable" aria-label={`Rename ${name}`} title="Rename" onClick={startEditing}>
            {name}
          </button>
        ) : (
          <span className="oui-doc-title__name">{name}</span>
        )}
      </h1>
      {status && (
        <span role="status" aria-live="polite" className={cx("oui-doc-title__status", saveState && `is-${saveState}`)}>
          {status}
        </span>
      )}
      {actions && <div className="oui-doc-title__actions">{actions}</div>}
    </div>
  );
}
