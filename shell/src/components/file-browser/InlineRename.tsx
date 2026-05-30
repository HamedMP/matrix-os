"use client";

import { useState, useRef, useEffect } from "react";

interface InlineRenameProps {
  name: string;
  onCommit: (newName: string) => void;
  onCancel: () => void;
}

export function InlineRename({ name, onCommit, onCancel }: InlineRenameProps) {
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- editable rename buffer, not a mirror of `name`: it seeds from the current name once, then holds the user's in-progress edits, which must not be overwritten when the prop is unchanged.
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dotIndex = name.lastIndexOf(".");
    if (dotIndex > 0) {
      input.setSelectionRange(0, dotIndex);
    } else {
      input.select();
    }
  }, [name]);

  function handleKeyDown(e: React.KeyboardEvent) {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  function commit() {
    if (committedRef.current) return;
    const trimmed = value.trim();
    if (!trimmed || trimmed === name) {
      onCancel();
      return;
    }
    committedRef.current = true;
    onCommit(trimmed);
  }

  return (
    <input
      ref={inputRef}
      aria-label="Rename"
      className="text-xs bg-background border rounded px-1 py-0.5 w-full text-center outline-none focus:ring-1 focus:ring-primary"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      onBlur={commit}
    />
  );
}
