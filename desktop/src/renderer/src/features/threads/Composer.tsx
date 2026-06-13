import { CornerDownLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog } from "../../design/primitives";
import { sendKernelMessage } from "../../lib/kernel-wiring";
import { useBoard } from "../../stores/board";
import { useTabs } from "../../stores/tabs";
import { useThreads } from "../../stores/threads";
import { useUi } from "../../stores/ui";

// Mounted only while open, so input state is fresh per open and autoFocus
// replaces a focus setTimeout (react-doctor: no leaked timer, no prop-sync).
function ComposerForm({ onClose }: { onClose: () => void }) {
  const activeTab = useTabs((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const openTab = useTabs((s) => s.openTab);
  const startThread = useThreads((s) => s.startThread);
  const setActiveThread = useThreads((s) => s.setActiveThread);
  const cardsByProject = useBoard((s) => s.cardsByProject);
  const [text, setText] = useState("");

  const boundTask = useMemo(() => {
    if (activeTab?.kind !== "task" || !activeTab.taskId) return null;
    for (const cards of Object.values(cardsByProject)) {
      const card = cards.find((c) => c.id === activeTab.taskId);
      if (card) return card;
    }
    return null;
  }, [activeTab, cardsByProject]);

  const submit = () => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const requestId = crypto.randomUUID();
    const thread = startThread({
      text: trimmed,
      title: trimmed.length > 60 ? `${trimmed.slice(0, 57)}…` : trimmed,
      taskId: boundTask?.id ?? null,
      sessionId: null,
      requestId,
    });
    sendKernelMessage({ text: trimmed, requestId });
    setActiveThread(thread.id);
    onClose();
    // Agent runs live inside the unified chat now; the new thread is selected
    // in the chat rail (ChatTab focuses the active thread).
    openTab({ kind: "chat", title: "Hermes", closable: false });
  };

  return (
    <div className="flex flex-col gap-2 p-4">
      {boundTask ? (
        <span
          className="self-start rounded-full border px-2 py-0.5 text-xs"
          style={{ borderColor: "var(--border-default)", color: "var(--text-secondary)" }}
        >
          Task: {boundTask.title}
        </span>
      ) : null}
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Ask Hermes to do something…"
        rows={3}
        maxLength={100_000}
        className="w-full resize-none bg-transparent text-md outline-none"
        style={{ color: "var(--text-primary)" }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="flex items-center justify-between">
        <span className="text-xs" style={{ color: "var(--text-tertiary)" }}>
          Runs on your computer as an agent thread
        </span>
        <button
          type="button"
          disabled={text.trim().length === 0}
          onClick={submit}
          className="inline-flex h-7 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors duration-100 disabled:opacity-50"
          style={{ background: "var(--accent)", color: "var(--text-on-accent)" }}
        >
          Start
          <span className="flex items-center gap-0.5 text-xs opacity-80">
            ⌘<CornerDownLeft size={11} />
          </span>
        </button>
      </div>
    </div>
  );
}

export default function Composer() {
  const open = useUi((s) => s.composerOpen);
  const setOpen = useUi((s) => s.setComposerOpen);
  return (
    <Dialog open={open} onClose={() => setOpen(false)} width={560}>
      <ComposerForm onClose={() => setOpen(false)} />
    </Dialog>
  );
}
