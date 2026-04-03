"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import type { Theme } from "@/hooks/useTheme";

interface SearchAddon {
  findNext: (query: string, options?: { caseSensitive?: boolean }) => boolean;
  findPrevious: (query: string, options?: { caseSensitive?: boolean }) => boolean;
  clearDecorations: () => void;
  onDidChangeResults?: (callback: (result: { resultIndex: number; resultCount: number }) => void) => { dispose: () => void };
}

interface TerminalSearchBarProps {
  searchAddon: SearchAddon;
  isOpen: boolean;
  onClose: () => void;
  theme: Theme;
}

export function TerminalSearchBar({ searchAddon, isOpen, onClose, theme }: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    if (!searchAddon.onDidChangeResults) return;
    const disposable = searchAddon.onDidChangeResults((result) => {
      setResultIndex(result.resultIndex);
      setResultCount(result.resultCount);
    });
    return () => disposable.dispose();
  }, [searchAddon]);

  const findNext = useCallback(() => {
    if (!query) return;
    searchAddon.findNext(query, { caseSensitive });
  }, [searchAddon, query, caseSensitive]);

  const findPrevious = useCallback(() => {
    if (!query) return;
    searchAddon.findPrevious(query, { caseSensitive });
  }, [searchAddon, query, caseSensitive]);

  const close = useCallback(() => {
    searchAddon.clearDecorations();
    setQuery("");
    setResultIndex(-1);
    setResultCount(0);
    onClose();
  }, [searchAddon, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (e.key === "Enter") {
      if (e.shiftKey) {
        findPrevious();
      } else {
        findNext();
      }
      e.preventDefault();
    }
  }, [close, findNext, findPrevious]);

  useEffect(() => {
    if (query) {
      searchAddon.findNext(query, { caseSensitive });
    } else {
      searchAddon.clearDecorations();
      setResultIndex(-1);
      setResultCount(0);
    }
  }, [query, caseSensitive, searchAddon]);

  const surface = theme.colors.surface || theme.colors.card || "#2d2d3d";
  const border = theme.colors.border || theme.colors.muted || "#444";
  const fg = theme.colors.foreground || "#e0e0e0";
  const primary = theme.colors.primary || "#c2703a";

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 10,
        display: "flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 8px",
        borderRadius: 6,
        background: surface,
        border: `1px solid ${border}`,
        color: fg,
        fontSize: 12,
        fontFamily: "system-ui, sans-serif",
      }}
      onKeyDown={handleKeyDown}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
        style={{
          background: "transparent",
          border: "none",
          outline: "none",
          color: fg,
          width: 160,
          fontSize: 12,
        }}
      />
      {query && resultCount >= 0 && (
        <span style={{ opacity: 0.7, whiteSpace: "nowrap", fontSize: 11 }}>
          {resultCount > 0 ? `${resultIndex + 1} of ${resultCount}` : "No results"}
        </span>
      )}
      <button
        onClick={() => setCaseSensitive((v) => !v)}
        title="Case Sensitive"
        style={{
          background: caseSensitive ? primary + "33" : "transparent",
          border: `1px solid ${caseSensitive ? primary : "transparent"}`,
          borderRadius: 3,
          color: fg,
          cursor: "pointer",
          padding: "1px 4px",
          fontSize: 11,
          fontWeight: caseSensitive ? 600 : 400,
        }}
      >
        Aa
      </button>
      <button
        onClick={findPrevious}
        title="Previous Match (Shift+Enter)"
        style={{
          background: "transparent",
          border: "none",
          color: fg,
          cursor: "pointer",
          padding: "1px 4px",
          fontSize: 13,
        }}
      >
        &uarr;
      </button>
      <button
        onClick={findNext}
        title="Next Match (Enter)"
        style={{
          background: "transparent",
          border: "none",
          color: fg,
          cursor: "pointer",
          padding: "1px 4px",
          fontSize: 13,
        }}
      >
        &darr;
      </button>
      <button
        onClick={close}
        title="Close (Escape)"
        style={{
          background: "transparent",
          border: "none",
          color: fg,
          cursor: "pointer",
          padding: "1px 4px",
          fontSize: 13,
        }}
      >
        &times;
      </button>
    </div>
  );
}
