import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@matrix-os/ui";
import { invoke } from "../../lib/operator";
import { TerminalFindBar, type TerminalSearch } from "../terminal/TerminalFindBar";

type ReadState = { status: "loading" } | { status: "failed" } | { status: "ready"; text: string };
type Match = { start: number; end: number };

function savedOutputSearch(text: string, show: (match: Match | null) => void): TerminalSearch {
  type Listener = Parameters<TerminalSearch["onDidChangeResults"]>[0];
  let listener: Listener | undefined;
  let query = "";
  let matches: Match[] = [];
  let index = -1;

  function find(term: string, step: 1 | -1): boolean {
    if (term !== query) {
      query = term;
      const literal = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      matches = term ? Array.from(text.matchAll(new RegExp(literal, "giu")), (match) => ({
        start: match.index,
        end: match.index + match[0].length,
      })) : [];
      index = step === 1 ? -1 : 0;
    }
    index = matches.length ? (index + step + matches.length) % matches.length : -1;
    show(matches[index] ?? null);
    listener?.({ resultIndex: index, resultCount: matches.length });
    return index >= 0;
  }

  return {
    findNext: (term) => find(term, 1),
    findPrevious: (term) => find(term, -1),
    clearDecorations() {
      query = "";
      matches = [];
      index = -1;
      show(null);
    },
    onDidChangeResults(next) {
      listener = next;
      return { dispose() { listener = undefined; } };
    },
  };
}

function SavedOutput({ text, findRequest }: { text: string; findRequest: number }) {
  const output = useRef<HTMLPreElement>(null);
  const highlight = useRef<HTMLElement>(null);
  const [match, setMatch] = useState<Match | null>(null);
  const [closedRequest, setClosedRequest] = useState(0);
  const search = useMemo(() => savedOutputSearch(text, setMatch), [text]);

  useEffect(() => { highlight.current?.scrollIntoView?.({ block: "nearest" }); }, [match]);

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <pre ref={output} aria-label="Saved terminal output" tabIndex={0}
        className="min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[13px]">
        {match ? <>{text.slice(0, match.start)}<mark ref={highlight}>{text.slice(match.start, match.end)}</mark>{text.slice(match.end)}</> : text}
      </pre>
      {findRequest > 0 && closedRequest !== findRequest ? (
        <TerminalFindBar search={search} request={findRequest} onClose={() => {
          setClosedRequest(findRequest);
          output.current?.focus();
        }} />
      ) : null}
    </div>
  );
}

export function FinishedTerminalOutput({ terminalKey, terminalId, focused, findRequest, onDisplayed }: {
  terminalKey: string; terminalId: string; focused: boolean; findRequest: number;
  onDisplayed(key: string): () => void;
}) {
  const [read, setRead] = useState<ReadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    void invoke("local-terminal:history", { id: terminalId }).then((result) => {
      if (current) setRead(result.ok ? { status: "ready", text: result.text } : { status: "failed" });
    }, (error: unknown) => {
      console.warn("[terminal-window] saved output unavailable:", error instanceof Error ? error.name : "UnknownError");
      if (current) setRead({ status: "failed" });
    });
    return () => { current = false; };
  }, [attempt, terminalId]);

  useEffect(() => {
    if (read.status === "ready" && focused) return onDisplayed(terminalKey);
    return undefined;
  }, [focused, onDisplayed, read.status, terminalKey]);

  if (read.status === "loading") return <p role="status" className="p-3 text-xs">Loading saved output…</p>;
  if (read.status === "failed") {
    return (
      <div className="flex items-center gap-2 p-3 text-xs">
        <p role="alert">Couldn't load saved output.</p>
        <Button variant="secondary" size="sm" onClick={() => {
          setRead({ status: "loading" });
          setAttempt((value) => value + 1);
        }}>Retry</Button>
      </div>
    );
  }
  if (!read.text) return <p className="p-3 text-xs">This terminal ended without saved output.</p>;
  return <SavedOutput text={read.text} findRequest={findRequest} />;
}
