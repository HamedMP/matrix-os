"use client";

import { useState, useRef, useEffect, useCallback, type CSSProperties } from "react";
import type { Theme } from "@/hooks/useTheme";

const CONTAINER_BASE_STYLE: CSSProperties = {
  position: "absolute",
  top: 8,
  right: 8,
  zIndex: 10,
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 8px",
  borderRadius: 6,
  fontSize: 12,
  fontFamily: "system-ui, sans-serif",
};

const CASE_BUTTON_BASE_STYLE: CSSProperties = {
  borderRadius: 3,
  cursor: "pointer",
  padding: "1px 4px",
  fontSize: 12,
};

const ICON_BUTTON_STYLE: CSSProperties = {
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "1px 4px",
  fontSize: 13,
};

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

// react-doctor-disable-next-line react-doctor/prefer-useReducer -- the five fields are not one related cluster: query and caseSensitive are independent controlled inputs, while resultIndex/resultCount/hasSearched are async addon-driven feedback with a distinct lifecycle; a reducer would not simplify these unrelated lifecycles.
export function TerminalSearchBar({ searchAddon, isOpen, onClose, theme }: TerminalSearchBarProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [resultIndex, setResultIndex] = useState(-1);
  const [resultCount, setResultCount] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- the three setters apply one logical search-results event delivered by the xterm search addon's onDidChangeResults callback; they are batched into a single render by React and cannot be derived during render because the values arrive asynchronously from an external imperative addon.
  useEffect(() => {
    if (!searchAddon.onDidChangeResults) return;
    const disposable = searchAddon.onDidChangeResults((result) => {
      setResultIndex(result.resultIndex);
      setResultCount(result.resultCount);
      setHasSearched(true);
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
    setHasSearched(false);
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

  // This effect synchronizes the controlled query/caseSensitive inputs with the
  // external xterm search addon (an imperative system). The setState resets are
  // not derived from props and cannot run during render: setHasSearched(false)
  // must precede the imperative findNext so the result feedback ("N of M"/"No
  // results") stays hidden until the addon asynchronously reports fresh results
  // via onDidChangeResults. searchAddon is a stable imperative handle, not live
  // parent state.
  // react-doctor-disable-next-line react-doctor/no-cascading-set-state -- intentional: clearing query resets the three result-feedback fields together, while a non-empty query only hides stale feedback before the async addon search; consolidating would not change the rendered output.
  useEffect(() => {
    if (query) {
      // react-doctor-disable-next-line react-hooks-js/set-state-in-effect, react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- hide stale result feedback before the imperative addon search; re-shown only when onDidChangeResults fires.
      setHasSearched(false);
      // react-doctor-disable-next-line react-doctor/no-pass-live-state-to-parent -- not lifting state: this invokes the imperative search method on the xterm addon handle (the actual search action), not a parent state setter.
      searchAddon.findNext(query, { caseSensitive });
    } else {
      searchAddon.clearDecorations();
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- reset result feedback to its empty-query baseline; values are addon-driven, not derivable during render.
      setResultIndex(-1);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- reset result feedback to its empty-query baseline; values are addon-driven, not derivable during render.
      setResultCount(0);
      // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change, react-doctor/no-chain-state-updates -- reset result feedback to its empty-query baseline; values are addon-driven, not derivable during render.
      setHasSearched(false);
    }
  }, [query, caseSensitive, searchAddon]);

  const surface = theme.colors.surface || theme.colors.card || "#2d2d3d";
  const border = theme.colors.border || theme.colors.muted || "#444";
  const fg = theme.colors.foreground || "#e0e0e0";
  const primary = theme.colors.primary || "#c2703a";

  if (!isOpen) return null;

  return (
    <div
      role="search"
      onKeyDown={handleKeyDown}
      style={{
        ...CONTAINER_BASE_STYLE,
        background: surface,
        border: `1px solid ${border}`,
        color: fg,
      }}
    >
      <input
        ref={inputRef}
        type="text"
        aria-label="Search terminal"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search..."
        style={{
          background: "transparent",
          border: "none",
          color: fg,
          width: 160,
          fontSize: 12,
        }}
      />
      {query && hasSearched && (
        <span style={{ opacity: 0.7, whiteSpace: "nowrap", fontSize: 12 }}>
          {resultCount > 0 ? `${resultIndex + 1} of ${resultCount}` : "No results"}
        </span>
      )}
      <button
        type="button"
        onClick={() => setCaseSensitive((v) => !v)}
        title="Case Sensitive"
        style={{
          ...CASE_BUTTON_BASE_STYLE,
          background: caseSensitive ? primary + "33" : "transparent",
          border: `1px solid ${caseSensitive ? primary : "transparent"}`,
          color: fg,
          fontWeight: caseSensitive ? 600 : 400,
        }}
      >
        Aa
      </button>
      <button
        type="button"
        onClick={findPrevious}
        title="Previous Match (Shift+Enter)"
        style={{ ...ICON_BUTTON_STYLE, color: fg }}
      >
        &uarr;
      </button>
      <button
        type="button"
        onClick={findNext}
        title="Next Match (Enter)"
        style={{ ...ICON_BUTTON_STYLE, color: fg }}
      >
        &darr;
      </button>
      <button
        type="button"
        onClick={close}
        title="Close (Escape)"
        style={{ ...ICON_BUTTON_STYLE, color: fg }}
      >
        &times;
      </button>
    </div>
  );
}
