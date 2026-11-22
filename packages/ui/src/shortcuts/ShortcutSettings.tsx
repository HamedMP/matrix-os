import { useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Search } from "lucide-react";
import {
  EMPTY_SHORTCUT_OVERRIDES,
  MAX_BINDINGS_PER_ACTION,
  SHORTCUT_ACTIONS,
  addBinding,
  findConflict,
  isOverridden,
  removeBinding,
  resetAction,
  resolveShortcuts,
  validateBinding,
  type ShortcutActionDefinition,
  type ShortcutActionId,
  type ShortcutGroup,
  type ShortcutOverrides,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";
import { Button } from "../Button.js";
import { Dialog } from "../Dialog.js";
import { DialogFooter } from "../DialogFooter.js";
import { DialogTitle } from "../DialogTitle.js";
import { Input } from "../Input.js";
import { quietButtonStyle } from "./quiet-button-style.js";
import { ShortcutRow, type RowNotice } from "./ShortcutRow.js";
import { useShortcutRecorder } from "./use-shortcut-recorder.js";
import {
  GROUP_TITLES,
  SHORTCUT_COPY,
  bindingText,
  conflictMessage,
  emptySearchMessage,
  rejectionMessage,
} from "./shortcut-copy.js";

export interface ShortcutSettingsProps {
  platform: ShortcutPlatform;
  overrides: ShortcutOverrides;
  saving?: boolean;
  error?: string | null;
  /** Persists the next overrides; resolves false when the save failed. */
  onChange(next: ShortcutOverrides): Promise<boolean>;
  onRecordingChange?(recording: boolean): void;
}

type PendingNotice =
  | { actionId: ShortcutActionId; kind: "conflict"; binding: string; owner: ShortcutActionId }
  | { actionId: ShortcutActionId; kind: "message"; text: string };

const GROUP_ORDER: readonly ShortcutGroup[] = ["apps", "navigation", "tabs", "chat", "terminal"];
const ACTION_LABELS = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action.label]));
const isSwitchAction = (id: ShortcutActionId) => id.startsWith("app.switch-");

/** Restore-all is the only save that is not tied to one row. */
const SECTION = "section" as const;
type SaveScope = ShortcutActionId | typeof SECTION;

const searchInputStyle: CSSProperties = {
  paddingLeft: "34px",
  height: "36px",
  background: "var(--mxs-field)",
  color: "var(--mxs-text)",
  borderColor: "var(--mxs-border)",
  borderRadius: "10px",
};

const dialogStyle: CSSProperties = {
  background: "var(--mxs-dialog)",
  color: "var(--mxs-text)",
  maxWidth: "400px",
};

const confirmStyle: CSSProperties = {
  background: "var(--mxs-accent)",
  color: "var(--mxs-on-accent)",
};

/**
 * Restores an action's defaults, taking back any default binding that another
 * action's override still holds, so the row never resets to nothing.
 */
function resetToDefaults(overrides: ShortcutOverrides, id: ShortcutActionId, platform: ShortcutPlatform): ShortcutOverrides {
  let next = resetAction(overrides, id);
  const defaults = SHORTCUT_ACTIONS.find((action) => action.id === id)?.defaults[platform] ?? [];
  for (const binding of defaults) {
    const holder = findConflict(resolveShortcuts(next, platform), binding, id);
    if (holder !== null && isOverridden(next, holder)) next = removeBinding(next, holder, binding, platform);
  }
  return next;
}

function matchesQuery(action: ShortcutActionDefinition, bindings: readonly string[], query: string, platform: ShortcutPlatform) {
  if (query === "") return true;
  const compact = query.replace(/\s+/g, "");
  if (action.label.toLowerCase().includes(query) || action.description.toLowerCase().includes(query)) return true;
  return bindings.some(
    (binding) =>
      bindingText(binding, platform).toLowerCase().includes(compact) ||
      binding.toLowerCase().includes(compact),
  );
}

export function ShortcutSettings({
  platform,
  overrides,
  saving = false,
  error = null,
  onChange,
  onRecordingChange,
}: ShortcutSettingsProps) {
  const searchId = useId();
  const switchListId = useId();
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<PendingNotice | null>(null);
  const [failedScope, setFailedScope] = useState<SaveScope | null>(null);
  const [switchOpen, setSwitchOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  // Each save is built from the current `overrides` prop, so a second save
  // started before the host re-renders would revert the first one.
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const busy = saving || pending;

  // A notice belongs to the overrides it was computed from.
  const [noticeOverrides, setNoticeOverrides] = useState(overrides);
  if (noticeOverrides !== overrides) {
    setNoticeOverrides(overrides);
    setNotice(null);
  }

  const effective = useMemo(() => resolveShortcuts(overrides, platform), [overrides, platform]);

  const save = async (scope: SaveScope, next: ShortcutOverrides) => {
    if (pendingRef.current || saving) return;
    pendingRef.current = true;
    setPending(true);
    let saved = false;
    try {
      saved = await onChange(next);
    } catch (cause: unknown) {
      console.error("[shortcuts] saving shortcut overrides failed", cause);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
    setFailedScope(saved ? null : scope);
  };

  const changeQuery = (value: string) => {
    setQuery(value);
    setNotice(null);
  };
  const failureText = error ?? SHORTCUT_COPY.saveFailed;

  const handleCapture = (id: ShortcutActionId, binding: string) => {
    setNotice(null);
    const current = effective[id];
    if (current.includes(binding)) return;
    const verdict = validateBinding(binding, platform);
    if (!verdict.ok) {
      setNotice({ actionId: id, kind: "message", text: rejectionMessage(binding, verdict, platform) });
      return;
    }
    if (current.length >= MAX_BINDINGS_PER_ACTION) {
      setNotice({ actionId: id, kind: "message", text: SHORTCUT_COPY.limit });
      return;
    }
    const owner = findConflict(effective, binding, id);
    if (owner !== null) {
      setNotice({ actionId: id, kind: "conflict", binding, owner });
      return;
    }
    void save(id, addBinding(overrides, id, binding, platform));
  };
  const recorder = useShortcutRecorder<ShortcutActionId>({ platform, onCapture: handleCapture, onRecordingChange });

  const normalizedQuery = query.trim().toLowerCase();
  const visible = SHORTCUT_ACTIONS.filter((action) =>
    matchesQuery(action, effective[action.id], normalizedQuery, platform),
  );
  const visibleSwitches = visible.filter((action) => isSwitchAction(action.id));
  const switchExpanded = switchOpen || (normalizedQuery !== "" && visibleSwitches.length > 0);

  const rowNotice = (id: ShortcutActionId): RowNotice | null => {
    if (notice === null || notice.actionId !== id) return null;
    if (notice.kind === "message") return notice;
    const { binding, owner } = notice;
    return {
      kind: "conflict",
      text: conflictMessage(binding, ACTION_LABELS.get(owner) ?? owner, platform),
      onReplace: () => {
        setNotice(null);
        void save(id, addBinding(overrides, id, binding, platform));
      },
      onCancel: () => setNotice(null),
    };
  };

  const renderRow = (action: ShortcutActionDefinition) => (
    <ShortcutRow
      key={action.id}
      action={action}
      platform={platform}
      bindings={effective[action.id]}
      overridden={isOverridden(overrides, action.id)}
      busy={busy}
      recording={recorder.target === action.id}
      held={recorder.target === action.id ? recorder.held : []}
      notice={rowNotice(action.id)}
      error={failedScope === action.id ? failureText : null}
      onStartRecording={(trigger) => {
        setNotice(null);
        recorder.start(action.id, trigger);
      }}
      onCancelRecording={recorder.cancel}
      onRemove={(binding) => void save(action.id, removeBinding(overrides, action.id, binding, platform))}
      onReset={() => void save(action.id, resetToDefaults(overrides, action.id, platform))}
    />
  );

  const renderGroup = (group: ShortcutGroup) => {
    const actions = visible.filter((action) => action.group === group);
    if (actions.length === 0) return null;
    const firstSwitch = actions.findIndex((action) => isSwitchAction(action.id));
    const plain = actions.filter((action) => !isSwitchAction(action.id));
    const headingId = `${searchId}-${group}`;
    return (
      <section key={group} className="mxs-group" aria-labelledby={headingId}>
        <h4 id={headingId} className="mxs-group-title">
          {GROUP_TITLES[group]}
        </h4>
        <div className="mxs-card">
          {plain.slice(0, firstSwitch === -1 ? plain.length : firstSwitch).map(renderRow)}
          {firstSwitch === -1 ? null : (
            <div className="mxs-disclosure">
              <button
                type="button"
                className="mxs-disclosure-toggle"
                aria-expanded={switchExpanded}
                aria-controls={switchListId}
                onClick={() => setSwitchOpen((open) => !open)}
              >
                <span className="mxs-row-text">
                  <span className="mxs-row-title">{SHORTCUT_COPY.switchGroupTitle}</span>
                  <span className="mxs-row-description">{SHORTCUT_COPY.switchGroupDescription}</span>
                </span>
                <ChevronRight className="mxs-disclosure-chevron" size={16} aria-hidden="true" />
              </button>
              {switchExpanded ? (
                <div id={switchListId} className="mxs-disclosure-body">
                  {visibleSwitches.map(renderRow)}
                </div>
              ) : null}
            </div>
          )}
          {firstSwitch === -1 ? null : plain.slice(firstSwitch).map(renderRow)}
        </div>
      </section>
    );
  };

  const hasOverrides = Object.keys(overrides.overrides).length > 0;

  return (
    <div className="mxs-shortcuts">
      <p className="mxs-intro">{SHORTCUT_COPY.description}</p>

      <div className="mxs-search">
        <Search className="mxs-search-icon" size={16} aria-hidden="true" />
        <Input
          id={searchId}
          type="search"
          aria-label={SHORTCUT_COPY.searchLabel}
          placeholder={SHORTCUT_COPY.searchPlaceholder}
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => changeQuery(event.target.value)}
          style={searchInputStyle}
        />
      </div>

      {failedScope === SECTION ? (
        <p className="mxs-section-error" role="alert">
          {failureText}
        </p>
      ) : null}

      {visible.length === 0 ? (
        <div className="mxs-empty">
          <p>{emptySearchMessage(query.trim())}</p>
          <Button variant="secondary" size="sm" className="mxs-outline" onClick={() => changeQuery("")}>
            {SHORTCUT_COPY.clearSearch}
          </Button>
        </div>
      ) : (
        GROUP_ORDER.map(renderGroup)
      )}

      <div className="mxs-footer">
        <Button
          variant="ghost"
          size="sm"
          className="mxs-quiet"
          style={quietButtonStyle}
          disabled={busy || !hasOverrides}
          onClick={() => setRestoreOpen(true)}
        >
          {SHORTCUT_COPY.restoreAll}
        </Button>
      </div>

      <Dialog open={restoreOpen} onClose={() => setRestoreOpen(false)} className="mxs-dialog" style={dialogStyle} aria-labelledby={`${searchId}-restore`}>
        <DialogTitle id={`${searchId}-restore`} style={{ color: "var(--mxs-text)", fontSize: "1.0625rem" }}>
          {SHORTCUT_COPY.restoreTitle}
        </DialogTitle>
        <p className="mxs-dialog-body">{SHORTCUT_COPY.restoreBody}</p>
        <DialogFooter>
          <Button variant="secondary" size="sm" className="mxs-outline" onClick={() => setRestoreOpen(false)}>
            {SHORTCUT_COPY.cancel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            style={confirmStyle}
            disabled={busy}
            onClick={() => {
              setRestoreOpen(false);
              setNotice(null);
              void save(SECTION, EMPTY_SHORTCUT_OVERRIDES);
            }}
          >
            {SHORTCUT_COPY.restoreConfirm}
          </Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}

