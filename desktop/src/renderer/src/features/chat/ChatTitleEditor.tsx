import { useEffect, useRef, useState } from "react";

export function ChatTitleEditor({
  title,
  disabled = false,
  className = "",
  onCommit,
  onCancel,
}: {
  title: string;
  disabled?: boolean;
  className?: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(title);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    if (settledRef.current || disabled) return;
    const nextTitle = value.trim();
    if (!nextTitle || nextTitle === title) {
      settledRef.current = true;
      onCancel();
      return;
    }
    settledRef.current = true;
    onCommit(nextTitle);
  };

  return (
    <input
      ref={inputRef}
      type="text"
      aria-label={`Rename ${title}`}
      value={value}
      maxLength={160}
      disabled={disabled}
      className={`no-drag min-w-0 rounded border bg-[var(--bg-surface)] px-1.5 py-0.5 text-inherit font-inherit outline-none focus:border-[var(--accent)] ${className}`}
      style={{ color: "var(--text-primary)", borderColor: "var(--border-default)" }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onChange={(event) => setValue(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          settledRef.current = true;
          onCancel();
        }
      }}
    />
  );
}
