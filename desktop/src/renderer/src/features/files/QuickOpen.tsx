import { File } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useConnection } from "../../stores/connection";
import { useUi } from "../../stores/ui";
import { useEditorTabs } from "../editor/editor-tabs-store";
import { useWorkspace } from "../../stores/workspace";

const SEARCH_DEBOUNCE_MS = 150;
const MAX_RESULTS = 30;

// Mounted only while open (fresh state per open, autoFocus instead of a focus
// timeout). The search debounce timer is cleared on each change and unmount.
function QuickOpenInner({ onClose }: { onClose: () => void }) {
  const view = useUi((s) => s.view);
  const navigate = useUi((s) => s.navigate);
  const api = useConnection((s) => s.api);
  const openTab = useEditorTabs((s) => s.openTab);
  const togglePanel = useWorkspace((s) => s.togglePanel);
  const layoutFor = useWorkspace((s) => s.layoutFor);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<string[]>([]);
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    if (!api || query.trim().length === 0) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .get<{ results?: unknown; entries?: unknown }>(
          `/api/files/search?q=${encodeURIComponent(query.trim())}&limit=${MAX_RESULTS}`,
        )
        .then((res) => {
          const raw = Array.isArray(res.results)
            ? res.results
            : Array.isArray(res.entries)
              ? res.entries
              : [];
          const paths: string[] = [];
          for (const item of raw.slice(0, MAX_RESULTS)) {
            if (typeof item === "string") paths.push(item);
            else if (item && typeof item === "object" && typeof (item as { path?: unknown }).path === "string") {
              paths.push((item as { path: string }).path);
            }
          }
          setResults(paths);
          setSelected(0);
        })
        .catch((err: unknown) => {
          console.warn("[quick-open] search failed:", err instanceof Error ? err.message : String(err));
          setResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [api, query]);

  const openPath = (path: string) => {
    onClose();
    if (view.kind !== "task") return;
    openTab(view.taskId, path);
    if (!layoutFor(view.taskId).visible.editor) togglePanel(view.taskId, "editor");
    navigate(view);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-[16vh]"
      style={{ background: "rgba(0,0,0,0.45)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="fade-in w-[560px] overflow-hidden rounded-xl border"
        style={{
          background: "var(--bg-overlay)",
          borderColor: "var(--border-default)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Go to file…"
          className="w-full border-b bg-transparent px-4 py-3 text-md outline-none"
          style={{ borderColor: "var(--border-subtle)", color: "var(--text-primary)" }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, results.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            }
            if (e.key === "Enter" && results[selected]) {
              openPath(results[selected]);
            }
          }}
        />
        <div className="max-h-[300px] overflow-y-auto p-1.5">
          {results.map((path, i) => (
            <button
              key={path}
              type="button"
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm"
              style={{
                background: i === selected ? "var(--bg-selected)" : "transparent",
                color: "var(--text-primary)",
              }}
              onMouseEnter={() => setSelected(i)}
              onClick={() => openPath(path)}
            >
              <File size={13} style={{ color: "var(--text-tertiary)" }} />
              <span className="truncate">{path}</span>
            </button>
          ))}
          {query.trim().length > 0 && results.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm" style={{ color: "var(--text-tertiary)" }}>
              No files found.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default function QuickOpen() {
  const open = useUi((s) => s.quickOpenOpen);
  const setOpen = useUi((s) => s.setQuickOpenOpen);
  if (!open) return null;
  return <QuickOpenInner onClose={() => setOpen(false)} />;
}
