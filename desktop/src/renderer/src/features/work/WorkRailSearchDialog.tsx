import type { CanonicalChatRecord } from "@matrix-os/contracts";
import { MessageSquare, Search, X } from "@renderer/lib/hugeicons";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "../../design/primitives";
import type { Project } from "../../stores/board";
import { buildWorkRailSearchResults } from "./work-rail-model";

export function WorkRailSearchDialog({
  open,
  records,
  projects,
  status,
  onClose,
  onSelect,
}: {
  open: boolean;
  records: readonly CanonicalChatRecord[];
  projects: readonly Project[];
  status: "idle" | "loading" | "ready" | "error";
  onClose: () => void;
  onSelect: (record: CanonicalChatRecord, project?: Project) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const listboxId = useId();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const results = useMemo(
    () => buildWorkRailSearchResults(records, projects, query),
    [projects, query, records],
  );
  useEffect(() => {
    setSelectedIndex((current) => (
      results.length === 0 ? 0 : Math.min(current, results.length - 1)
    ));
  }, [results.length]);
  useEffect(() => {
    if (!open) return;
    optionRefs.current[selectedIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, results, selectedIndex]);

  const close = () => {
    setQuery("");
    setSelectedIndex(0);
    onClose();
  };
  const select = (index: number) => {
    const result = results[index];
    if (!result) return;
    onSelect(result.record, result.project);
    setQuery("");
    setSelectedIndex(0);
  };
  const updateQuery = (next: string) => {
    setQuery(next);
    setSelectedIndex(0);
  };
  const moveSelection = (offset: number) => {
    if (results.length === 0) return;
    setSelectedIndex((current) => (current + offset + results.length) % results.length);
  };

  return (
    <Dialog open={open} onClose={close} width={560} title="Search chats" top="12vh">
      <div className="p-3">
        <div className="chat-search-field flex h-10 items-center gap-2 rounded-lg border px-3" style={{ borderColor: "var(--border-default)" }}>
          <Search size={16} aria-hidden style={{ color: "var(--text-tertiary)" }} />
          <input
            ref={searchInputRef}
            type="text"
            role="searchbox"
            aria-label="Search chats"
            aria-controls={listboxId}
            aria-autocomplete="list"
            aria-expanded="true"
            aria-activedescendant={results[selectedIndex]
              ? `${listboxId}-option-${selectedIndex}`
              : undefined}
            autoFocus
            value={query}
            className="h-full min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 text-sm shadow-none outline-none ring-0 focus:border-0 focus:ring-0"
            style={{
              appearance: "none",
              WebkitAppearance: "none",
              borderStyle: "none",
              borderWidth: 0,
              borderRadius: 0,
              boxShadow: "none",
              outline: "none",
              color: "var(--text-primary)",
            }}
            placeholder="Search chats"
            onChange={(event) => updateQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveSelection(1);
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                moveSelection(-1);
              } else if (event.key === "Enter") {
                event.preventDefault();
                select(selectedIndex);
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
          />
          <button
            type="button"
            aria-label="Clear Chat search"
            title="Clear Chat search"
            className="flex size-7 items-center justify-center rounded-md outline-none hover:bg-[var(--bg-hover)]"
            onClick={() => {
              updateQuery("");
              searchInputRef.current?.focus();
            }}
          >
            <X size={14} aria-hidden />
          </button>
        </div>
        <div className="mt-2 max-h-[min(480px,60vh)] overflow-y-auto rounded-lg border" style={{ borderColor: "var(--border-subtle)" }}>
          {status === "loading" && records.length === 0 ? (
            <p role="status" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>Loading chats…</p>
          ) : null}
          {status === "error" && records.length === 0 ? (
            <p role="alert" className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-secondary)" }}>Chats could not be loaded.</p>
          ) : null}
          {status === "error" && records.length > 0 ? (
            <p role="status" className="border-b px-3 py-2 text-xs" style={{ borderColor: "var(--border-subtle)", color: "var(--text-tertiary)" }}>
              Showing recently loaded chats. Refresh failed.
            </p>
          ) : null}
          {status !== "loading" && status !== "error" && records.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats yet.</p>
          ) : null}
          {records.length > 0 && results.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>No chats found.</p>
          ) : null}
          {results.length > 0 ? (
            <div id={listboxId} role="listbox" aria-label={query ? "Chat search results" : "Recent chats"}>
              {results.map((result, index) => (
                <button
                  key={result.record.chat.id}
                  id={`${listboxId}-option-${index}`}
                  ref={(node) => { optionRefs.current[index] = node; }}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-label={`${result.record.chat.title}, ${result.contextLabel}`}
                  aria-selected={index === selectedIndex}
                  className="flex w-full min-w-0 items-center gap-3 border-b px-3 py-2.5 text-left outline-none last:border-b-0 hover:bg-[var(--bg-hover)] aria-selected:bg-[var(--bg-selected)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]"
                  style={{ borderColor: "var(--border-subtle)" }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => select(index)}
                >
                  <MessageSquare size={15} aria-hidden className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm" style={{ color: "var(--text-primary)" }}>{result.record.chat.title}</span>
                    <span className="block truncate text-xs" style={{ color: "var(--text-tertiary)" }}>{result.contextLabel}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
