// Cmd+F in the Terminal window (spec 2706): find text in the terminal's
// screen and history with xterm's search addon.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { SearchAddon } from "@xterm/addon-search";

export type TerminalSearch = Pick<SearchAddon, "findNext" | "findPrevious" | "clearDecorations" | "onDidChangeResults">;

const DECORATIONS = { matchOverviewRuler: "#888888", activeMatchColorOverviewRuler: "#ffcc00", activeMatchBackground: "#ffcc0066" };
const buttonClass = "flex size-6 items-center justify-center rounded outline-none hover:bg-black/10 focus-visible:ring-2 focus-visible:ring-current disabled:opacity-40";

export function TerminalFindBar({ search, onClose }: { search: TerminalSearch; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  // The person just pressed Cmd+F: typing goes to the find field.
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const subscription = search.onDidChangeResults(({ resultIndex, resultCount }) => setResult({ index: resultIndex, count: resultCount }));
    return () => { subscription.dispose(); search.clearDecorations(); };
  }, [search]);
  const find = (forward: boolean, text = query) => {
    if (!text) { search.clearDecorations(); setResult(null); return; }
    if (forward) search.findNext(text, { decorations: DECORATIONS });
    else search.findPrevious(text, { decorations: DECORATIONS });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if (event.key === "Enter") { event.preventDefault(); find(!event.shiftKey); }
  };
  const label = !query ? "" : result && result.count > 0 ? `${result.index + 1} of ${result.count}` : "No results";
  return (
    <search className="absolute right-4 top-2 z-10 flex items-center gap-1 rounded-md border px-2 py-1 text-[12px]"
      style={{ background: "var(--bg-overlay)", borderColor: "var(--border-default)", color: "var(--text-primary)", boxShadow: "var(--shadow-2)" }}>
      <input ref={input} aria-label="Find in terminal" placeholder="Find" value={query} onKeyDown={onKeyDown}
        onChange={(event) => { setQuery(event.target.value); find(true, event.target.value); }}
        className="w-44 bg-transparent px-1 py-0.5 outline-none" />
      <span className="min-w-14 text-right tabular-nums" style={{ color: "var(--text-secondary)" }} aria-live="polite">{label}</span>
      <button type="button" aria-label="Previous match" disabled={!query} onClick={() => find(false)} className={buttonClass}><ChevronUp size={13} aria-hidden="true" /></button>
      <button type="button" aria-label="Next match" disabled={!query} onClick={() => find(true)} className={buttonClass}><ChevronDown size={13} aria-hidden="true" /></button>
      <button type="button" aria-label="Close find" onClick={onClose} className={buttonClass}><X size={13} aria-hidden="true" /></button>
    </search>
  );
}
