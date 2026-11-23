/**
 * The three-pane Mail workspace: folder rail, conversation list and reading
 * pane in resizable panes, with search, bulk actions, keyboard commands, the
 * undo toast and the composer and agent slots.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AlertCircle, Bot, Keyboard, Mail, PenSquare, RefreshCw, X } from "lucide-react";
import { AppFrame, SplitPane, useToast } from "../../../_shared/office-ui";
import type { MailAi } from "../agent/ai";
import {
  selectActiveDraft,
  selectActiveView,
  selectVisibleThreadKeys,
  type MailAccountEntry,
  type MailCommandEffect,
  type MailStore,
  type ThreadKey,
} from "../model";
import { BulkBar } from "./BulkBar";
import { hostBridge, MailUiContext, type MailBridge, type MailUi } from "./context";
import { FolderRail } from "./FolderRail";
import { createLayoutStore, DEFAULT_LAYOUT, LAYOUT_LIMITS, type MailLayout } from "./layout-prefs";
import { ReadingPane } from "./ReadingPane";
import { SearchBar } from "./SearchBar";
import { ShortcutHelp } from "./ShortcutHelp";
import { ComposerSlot, MailAgentPanelSlot } from "./slots";
import { ThreadList } from "./ThreadList";
import { UndoBar } from "./UndoBar";
import { useMailAgent } from "./use-mail-agent";
import { useMailKeyboard } from "./use-mail-keyboard";
import { useMailState } from "./use-mail-store";

export interface MailWorkspaceProps {
  store: MailStore;
  entries: readonly MailAccountEntry[];
  /** Defaults to `window.MatrixOS`. */
  bridge?: MailBridge;
  now?: () => number;
  timeZone?: string;
  /** Defaults to `MatrixOS.ai`; null turns the mail agent off. */
  ai?: MailAi | null;
}

function runtimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch (error: unknown) {
    if (error instanceof RangeError) return "UTC";
    throw error;
  }
}

const defaultNow = () => Date.now();

export function MailWorkspace({ store, entries, bridge = hostBridge(), now = defaultNow, timeZone, ai }: MailWorkspaceProps) {
  const state = useMailState(store);
  const agent = useMailAgent(store, entries, ai);
  const toast = useToast();
  const searchRef = useRef<HTMLInputElement>(null);
  const agentToggleRef = useRef<HTMLButtonElement>(null);
  const dragKeys = useRef<ThreadKey[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(false);
  const [layout, setLayout] = useState<MailLayout>(DEFAULT_LAYOUT);
  const [layoutStore] = useState(() => createLayoutStore(bridge));
  const zone = useMemo(() => timeZone ?? runtimeZone(), [timeZone]);

  useEffect(() => {
    let live = true;
    void layoutStore.load().then((loaded) => {
      if (live) setLayout(loaded);
    });
    return () => {
      live = false;
      layoutStore.dispose();
    };
  }, [layoutStore]);

  const resize = (patch: Partial<MailLayout>) => {
    const next = { ...layout, ...patch };
    setLayout(next);
    layoutStore.save(next);
  };

  const ui = useMemo<MailUi>(() => ({
    store,
    entries,
    bridge,
    now,
    timeZone: zone,
    ownAddresses: entries.map((entry) => entry.account.address.toLowerCase()),
    dragKeys,
    notify: (title, tone = "info", action) => {
      toast.show({ title, tone, action });
    },
  }), [store, entries, bridge, now, zone, toast]);

  const closeAgent = () => {
    setAgentOpen(false);
    agentToggleRef.current?.focus();
  };
  // Escape inside the panel closes it, unless a dialog opened from the panel took the key.
  const onAgentKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    const target = event.target as Element;
    if (target.closest('[role="dialog"], [role="alertdialog"]')) return;
    event.preventDefault();
    closeAgent();
  };

  const onEffect = (effect: MailCommandEffect) => {
    if (effect === "focusSearch") searchRef.current?.focus();
  };
  useMailKeyboard({ store, onEffect, onHelp: () => setHelpOpen(true), enabled: !helpOpen });

  const visible = selectVisibleThreadKeys(state, now(), zone);
  const view = selectActiveView(state);
  const draft = selectActiveDraft(state);
  const composing = draft !== null && draft.open;

  const banner = state.error ? (
    <div className="mail-banner" role="alert">
      <AlertCircle size={15} aria-hidden="true" />
      <span className="mail-banner__text">{state.error.message}</span>
      {state.error.retryable && (
        <button type="button" className="oui-button oui-button--ghost" onClick={() => { store.clearError(); void store.refresh(); }}>Try again</button>
      )}
      <button type="button" className="oui-icon-button" aria-label="Dismiss" onClick={() => store.clearError()}><X size={14} /></button>
    </div>
  ) : undefined;

  const titleActions = (
    <>
      <button type="button" className="oui-button oui-button--primary" onClick={() => store.compose()}>
        <PenSquare size={14} aria-hidden="true" /> New message
      </button>
      <button type="button" className="oui-icon-button" aria-label="Refresh" title="Refresh" onClick={() => void store.refresh()}>
        <RefreshCw size={15} className={view?.status === "loading" ? "mail-spin" : undefined} />
      </button>
      <button
        ref={agentToggleRef}
        type="button"
        className="oui-icon-button"
        aria-label="Mail agent"
        aria-pressed={agentOpen}
        title="Mail agent"
        onClick={() => setAgentOpen((open) => !open)}
      >
        <Bot size={16} />
      </button>
      <button type="button" className="oui-icon-button" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={() => setHelpOpen(true)}>
        <Keyboard size={16} />
      </button>
    </>
  );

  const statusText = view?.status === "loading"
    ? (view.fromCache ? "Showing saved mail, checking for new mail…" : "Loading…")
    : view?.loadedAt ? "Up to date" : view?.fromCache ? "Showing saved mail" : "";

  return (
    <MailUiContext.Provider value={ui}>
      <AppFrame
        className="mail-app"
        title="Mail"
        titleIcon={<Mail size={18} />}
        titleActions={titleActions}
        toolbar={<SearchBar ref={searchRef} searching={view?.descriptor.kind === "search"} />}
        banner={banner}
        rightPanel={agentOpen ? (
          <div className="mail-agent-dock" data-mail-keys="off" onKeyDown={onAgentKeyDown}>
            <MailAgentPanelSlot agent={agent} store={store} state={state} entries={entries} onClose={closeAgent} />
          </div>
        ) : undefined}
        rightPanelLabel="Mail agent"
        statusBar={<span className="mail-status" aria-live="polite">{statusText}</span>}
      >
        <SplitPane
          className="mail-split"
          label="Resize folder list"
          size={layout.rail}
          minSize={LAYOUT_LIMITS.rail.min}
          maxSize={LAYOUT_LIMITS.rail.max}
          onSizeChange={(rail) => resize({ rail })}
          first={<FolderRail state={state} />}
          second={(
            <SplitPane
              className="mail-split"
              label="Resize conversation list"
              size={layout.list}
              minSize={LAYOUT_LIMITS.list.min}
              maxSize={LAYOUT_LIMITS.list.max}
              onSizeChange={(list) => resize({ list })}
              first={(
                <section className="mail-list-pane" aria-label="Conversation list">
                  <BulkBar state={state} visible={visible} />
                  <ThreadList state={state} keys={visible} />
                </section>
              )}
              second={<section className="mail-reading-pane" aria-label="Reading pane"><ReadingPane state={state} /></section>}
            />
          )}
        />
        {composing && (
          <div className="mail-composer-dock" data-mail-keys="off">
            <ComposerSlot
              key={draft.localId}
              store={store}
              state={state}
              draft={draft}
              entries={entries}
              proposals={agent?.context.proposals}
              onClose={() => store.closeDraft(draft.localId)}
            />
          </div>
        )}
        <UndoBar undo={state.undo} />
        <ShortcutHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      </AppFrame>
    </MailUiContext.Provider>
  );
}
