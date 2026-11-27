/**
 * Find and replace: matches are painted in the editor's `search` layer, the
 * current one with `is-current`. Replacing goes through the session, so it is
 * one undo step and follows the Track changes toggle.
 */

import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Checkbox, useToast } from "../../../_shared/office-ui";
import type { DocumentEditorController, ViewMode } from "../editor/index";
import type { DocumentSession } from "../session/index";
import { MAX_QUERY_LENGTH, findMatches, replaceOps } from "./find-model";
import { visibleParagraphs } from "./text-index";

export const SEARCH_LAYER = "search";

export interface FindReplaceBarProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  viewMode: ViewMode;
  docVersion: number;
  /** Bumped by Ctrl+F / Ctrl+H to move focus back into the bar. */
  focusToken: number;
  readOnly: boolean;
  onClose: () => void;
}

export function FindReplaceBar({ session, editor, viewMode, docVersion, focusToken, readOnly, onClose }: FindReplaceBarProps) {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [current, setCurrent] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInput.current?.focus();
    findInput.current?.select();
  }, [focusToken]);

  const result = useMemo(() => {
    const doc = session.document;
    if (doc === null || query === "") return { matches: [], truncated: false };
    return findMatches(visibleParagraphs(doc, viewMode), query, { matchCase, wholeWord });
    // docVersion stands for the document content, which the engine handle does not expose as a value.
  }, [session, query, matchCase, wholeWord, viewMode, docVersion]);
  const matches = result.matches;
  const index = matches.length === 0 ? -1 : Math.min(current, matches.length - 1);

  useEffect(() => {
    if (editor === null) return undefined;
    editor.setHighlights(
      SEARCH_LAYER,
      matches.map((match, at) => ({ id: match.id, range: match.range, className: at === index ? "is-current" : undefined })),
    );
    return () => editor.clearHighlights(SEARCH_LAYER);
  }, [editor, matches, index]);

  const go = (step: number) => {
    if (matches.length === 0) return;
    const next = (index + step + matches.length) % matches.length;
    setCurrent(next);
    const match = matches[next];
    if (match !== undefined) editor?.setSelection(match.range, { scroll: true });
  };

  const apply = (ops: ReturnType<typeof replaceOps>): boolean => {
    try {
      session.apply(ops, { origin: "find" });
      return true;
    } catch (error) {
      console.warn("docs: replace failed", error);
      toast.show({ title: "Could not replace", description: "That part of the document cannot be changed here.", tone: "warning" });
      return false;
    }
  };

  // The shown results refresh after a short delay; a replacement always reads the document as it is now.
  const liveMatches = () => {
    const doc = session.document;
    if (doc === null || query === "") return [];
    return findMatches(visibleParagraphs(doc, viewMode), query, { matchCase, wholeWord }).matches;
  };

  const replaceCurrent = () => {
    const live = liveMatches();
    const match = live[Math.min(Math.max(index, 0), live.length - 1)];
    if (match !== undefined) apply(replaceOps([match], replacement));
  };

  const replaceAll = () => {
    const live = liveMatches();
    if (live.length === 0) return;
    const count = live.length;
    if (apply(replaceOps(live, replacement))) {
      setCurrent(0);
      toast.show({ title: `Replaced ${count} ${count === 1 ? "match" : "matches"}`, tone: "success" });
    }
  };

  const count = query === "" ? "" : matches.length === 0 ? "No results" : `${index + 1} of ${matches.length}${result.truncated ? "+" : ""}`;
  return (
    <search className="docs-find" aria-label="Find and replace">
      <div className="docs-find__row">
        <label className="docs-find__field">
          <span className="oui-sr-only">Find</span>
          <input
            ref={findInput}
            className="oui-input"
            placeholder="Find"
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            onChange={(event) => {
              setQuery(event.target.value);
              setCurrent(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                go(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        </label>
        <span className="docs-find__count" data-testid="find-count" aria-live="polite">
          {count}
        </span>
        <button type="button" className="oui-icon-button" aria-label="Previous match" title="Previous match (Shift+Enter)" disabled={matches.length === 0} onClick={() => go(-1)}>
          <ChevronUp size={16} aria-hidden="true" />
        </button>
        <button type="button" className="oui-icon-button" aria-label="Next match" title="Next match (Enter)" disabled={matches.length === 0} onClick={() => go(1)}>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <Checkbox label="Match case" checked={matchCase} onChange={setMatchCase} />
        <Checkbox label="Whole words" checked={wholeWord} onChange={setWholeWord} />
        <button type="button" className="oui-icon-button docs-find__close" aria-label="Close find" title="Close (Escape)" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="docs-find__row">
        <label className="docs-find__field">
          <span className="oui-sr-only">Replace with</span>
          <input
            className="oui-input"
            placeholder="Replace with"
            value={replacement}
            disabled={readOnly}
            onChange={(event) => setReplacement(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          />
        </label>
        <button type="button" className="oui-button" disabled={readOnly || index < 0} onClick={replaceCurrent}>
          Replace
        </button>
        <button type="button" className="oui-button" disabled={readOnly || matches.length === 0} onClick={replaceAll}>
          Replace all
        </button>
        {readOnly && <span className="docs-muted">The original view is read-only.</span>}
      </div>
    </search>
  );
}
