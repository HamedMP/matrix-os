import { useEffect, useId, useRef, type MouseEvent } from "react";
import {
  MAX_BINDINGS_PER_ACTION,
  formatBinding,
  type ShortcutActionDefinition,
  type ShortcutPlatform,
} from "@matrix-os/contracts/keyboard-shortcuts";
import { Button } from "../Button.js";
import { KeyChip } from "./KeyChip.js";
import { quietButtonStyle } from "./quiet-button-style.js";
import { SHORTCUT_COPY, recordingLabel, spokenBinding } from "./shortcut-copy.js";

export type RowNotice =
  | { kind: "conflict"; text: string; onReplace(): void; onCancel(): void }
  | { kind: "message"; text: string };

export interface ShortcutRowProps {
  action: ShortcutActionDefinition;
  platform: ShortcutPlatform;
  bindings: readonly string[];
  overridden: boolean;
  busy: boolean;
  recording: boolean;
  held: readonly string[];
  notice: RowNotice | null;
  error: string | null;
  onStartRecording(trigger: HTMLElement): void;
  onCancelRecording(options?: { restoreFocus?: boolean }): void;
  onRemove(binding: string): void;
  onReset(): void;
}

export function ShortcutRow({
  action,
  platform,
  bindings,
  overridden,
  busy,
  recording,
  held,
  notice,
  error,
  onStartRecording,
  onCancelRecording,
  onRemove,
  onReset,
}: ShortcutRowProps) {
  const titleId = useId();
  const descriptionId = useId();
  const atLimit = bindings.length >= MAX_BINDINGS_PER_ACTION;

  // Keep focus on the recording chip so pressing Add shortcut again toggles
  // recording off instead of blurring (cancelling) and restarting it.
  const keepRecordingFocus = (event: MouseEvent) => {
    if (recording) event.preventDefault();
  };

  const toggleRecording = (event: MouseEvent<HTMLButtonElement>) => {
    if (recording) onCancelRecording({ restoreFocus: true });
    else onStartRecording(event.currentTarget);
  };

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      className="mxs-row"
      data-recording={recording || undefined}
    >
      <div className="mxs-row-text">
        <span id={titleId} className="mxs-row-title">
          {action.label}
        </span>
        <span id={descriptionId} className="mxs-row-description">
          {action.description}
        </span>
      </div>

      <div className="mxs-row-controls">
        {bindings.length > 0 || recording ? (
          <div className="mxs-chips">
            {bindings.map((binding) => (
              <KeyChip
                key={binding}
                binding={binding}
                platform={platform}
                label={spokenBinding(binding, platform)}
                removeDisabled={busy}
                onRemove={() => onRemove(binding)}
              />
            ))}
            {recording ? (
              <RecordingChip
                actionLabel={action.label}
                platform={platform}
                held={held}
                onBlur={() => onCancelRecording()}
              />
            ) : null}
          </div>
        ) : null}

        <div className="mxs-row-actions">
          <Button
            variant="ghost"
            size="sm"
            className="mxs-quiet"
            style={{ ...quietButtonStyle, visibility: overridden ? "visible" : "hidden" }}
            disabled={busy}
            onClick={onReset}
          >
            {SHORTCUT_COPY.reset}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="mxs-quiet"
            style={quietButtonStyle}
            aria-pressed={recording}
            disabled={busy || atLimit}
            onMouseDown={keepRecordingFocus}
            onClick={toggleRecording}
          >
            {SHORTCUT_COPY.addShortcut}
          </Button>
        </div>
      </div>

      <RowFeedback notice={notice} error={error} atLimit={atLimit} busy={busy} />
    </div>
  );
}

function RecordingChip({
  actionLabel,
  platform,
  held,
  onBlur,
}: {
  actionLabel: string;
  platform: ShortcutPlatform;
  held: readonly string[];
  onBlur(): void;
}) {
  const chipRef = useRef<HTMLSpanElement>(null);

  // Focus lands here so leaving the row (blur) cancels recording.
  useEffect(() => {
    chipRef.current?.focus();
  }, []);

  return (
    <span className="mxs-chip-line">
      <span
        ref={chipRef}
        role="status"
        aria-label={recordingLabel(actionLabel)}
        tabIndex={-1}
        className="mxs-chip mxs-chip-recording"
        onBlur={onBlur}
      >
        {held.length > 0 ? (
          formatBinding(held.join("+"), platform).map((part) => (
            <kbd key={part} className="mxs-key">
              {part}
            </kbd>
          ))
        ) : (
          <span className="mxs-recording-text">{SHORTCUT_COPY.recording}</span>
        )}
      </span>
      <span className="mxs-chip-remove-space" aria-hidden="true" />
    </span>
  );
}

/** One line under the row: save error, conflict, rejection, or the limit. */
function RowFeedback({
  notice,
  error,
  atLimit,
  busy,
}: {
  notice: RowNotice | null;
  error: string | null;
  atLimit: boolean;
  busy: boolean;
}) {
  const text = error ?? notice?.text ?? (atLimit ? SHORTCUT_COPY.limit : null);
  const isProblem = error !== null || notice?.kind === "message";
  const conflict = error === null && notice?.kind === "conflict" ? notice : null;

  // The live region stays mounted so new messages are announced.
  return (
    <div className="mxs-row-feedback" aria-live="polite">
      {text === null ? null : (
        <p className="mxs-feedback-line" data-tone={isProblem ? "danger" : undefined} role={error === null ? undefined : "alert"}>
          <span>{text}</span>
          {conflict === null ? null : (
            <span className="mxs-feedback-actions">
              <Button variant="secondary" size="sm" className="mxs-conflict-button" disabled={busy} onClick={conflict.onReplace}>
                {SHORTCUT_COPY.replace}
              </Button>
              <Button variant="ghost" size="sm" className="mxs-quiet" style={quietButtonStyle} onClick={conflict.onCancel}>
                {SHORTCUT_COPY.cancel}
              </Button>
            </span>
          )}
        </p>
      )}
    </div>
  );
}
