"use client";

import { useState, type FormEvent } from "react";
import { BrainButton, BrainInput, BrainSelect } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { BrainBadge, BrainEmpty, BrainError, BrainView, type BrainScreenProps } from "./brain-ui.js";
import {
  BRAIN_SOURCE_CHOICES_MAX, BRAIN_SOURCE_DEFAULT_SETTINGS, BRAIN_SOURCE_KIND_LABELS, BRAIN_TYPED_SOURCE_INPUTS,
  brainSourceConfig, brainSourceSettingsProblem, brainTypedValues, type BrainSourceSettings, type BrainTypedSourceInput,
} from "./brain-format.js";
import { BrainSourceSettingsForm } from "./BrainSourceSettings.js";
import type {
  BrainConnectableSourceKind, BrainSourceKindView, BrainSourceOptionView, BrainSourceOptionsView,
} from "./brain-types.js";
import { useBrainAction, useBrainLoad, type BrainLoad } from "./use-brain-load.js";

const LABEL_MAX_CHARS = 120;
/** One repository or scope id, or up to 20 tags. */
const TYPED_MAX_CHARS = 1_000;

/**
 * not_connected: the owner has no account for it. not_configured covers every server-side gap (no integration key, no
 * Slack capture reader, no chat store, a missing table, a failed availability check), so it is worded neutrally.
 */
function kindStatus(view: BrainSourceKindView): string {
  if (view.available) return "Ready";
  return view.reason === "not_connected" ? "Connect the account in Settings" : "Not set up on this server";
}

/** Connect another source: pick a kind, choose what to include from its options (or type it), name it. */
export function BrainSourceConnect({ api, projectId, kinds, onConnected }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly kinds: readonly BrainSourceKindView[]; readonly onConnected: () => void;
}) {
  const [kind, setKind] = useState<BrainConnectableSourceKind | null>(null);
  const choices = kinds.filter((view): view is BrainSourceKindView & { kind: BrainConnectableSourceKind } => view.kind !== "git");
  return (
    <section aria-label="Connect a source"
      className={`grid grid-cols-[minmax(0,1fr)] gap-3 rounded-md border p-3 ${BRAIN_TONE.border}`}>
      <h3 className="text-sm font-semibold">Connect a source</h3>
      <label className="grid gap-1 text-sm">
        Kind
        <BrainSelect
          value={kind ?? ""}
          onChange={(event) => setKind(choices.find((view) => view.kind === event.target.value)?.kind ?? null)}
          className="w-full min-w-0 max-w-full"
        >
          <option value="">Choose a kind</option>
          {choices.map((view) => (
            <option key={view.kind} value={view.kind} disabled={!view.available}>
              {BRAIN_SOURCE_KIND_LABELS[view.kind]}{view.available ? "" : ` (${kindStatus(view)})`}
            </option>
          ))}
        </BrainSelect>
      </label>
      <ul aria-label="Source kinds" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {choices.map((view) => (
          <li key={view.kind} className="flex items-center gap-1.5">
            {BRAIN_SOURCE_KIND_LABELS[view.kind]}
            <BrainBadge tone={view.available ? "good" : "warn"}>{kindStatus(view)}</BrainBadge>
          </li>
        ))}
      </ul>
      {kind !== null && (
        <ConnectForm key={kind} api={api} projectId={projectId} kind={kind}
          onConnected={() => { setKind(null); onConnected(); }} />
      )}
    </section>
  );
}

interface ConnectDraft {
  /** The typed field when the kind lists no options (an error or an empty list); null shows the options. */
  readonly typedInput: BrainTypedSourceInput | null;
  /** Picked and typed values, de-duplicated; null when the typed text does not parse. */
  readonly values: readonly string[] | null;
  readonly ready: boolean;
}

/** What the form would send and whether it can be sent now. */
function connectDraft(kind: BrainConnectableSourceKind, state: BrainLoad<BrainSourceOptionsView>,
  picked: readonly string[], text: string, settings: BrainSourceSettings): ConnectDraft {
  const input = BRAIN_TYPED_SOURCE_INPUTS[kind];
  const listsNone = state.status === "error" || (state.status === "ready" && state.data.items.length === 0);
  const typedInput = input !== undefined && listsNone ? input : null;
  const typed = brainTypedValues(kind, typedInput === null ? "" : text);
  const values = typed === null ? null : [...new Set([...picked, ...typed])];
  const ready = values !== null && (state.status === "ready" || typedInput !== null)
    && values.length <= BRAIN_SOURCE_CHOICES_MAX[kind] && (values.length > 0 || kind === "matrix_notes")
    && brainSourceSettingsProblem(kind, settings) === null;
  return { typedInput, values, ready };
}

/** One choice switched on or off: a single-choice kind keeps only the last pick, others stop at `max`. */
function nextPicked(picked: readonly string[], id: string, on: boolean, max: number): readonly string[] {
  if (max === 1) return [id];
  return on ? [...picked, id].slice(0, max) : picked.filter((value) => value !== id);
}

/** The Connect button: one connect at a time, the name trimmed and cut, and left out when empty. */
function useConnectSubmit({ api, projectId, kind, onConnected }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly kind: BrainConnectableSourceKind; readonly onConnected: () => void;
}) {
  const action = useBrainAction();
  const connect = (values: readonly string[], settings: BrainSourceSettings, label: string) => {
    const name = label.trim().slice(0, LABEL_MAX_CHARS);
    action.run("connect", () => api.connectSource(projectId, {
      kind, config: brainSourceConfig(kind, values, settings), ...(name === "" ? {} : { label: name }),
    }), onConnected);
  };
  return { busy: action.busy !== null, error: action.error, connect };
}

function ConnectForm({ api, projectId, kind, onConnected }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly kind: BrainConnectableSourceKind; readonly onConnected: () => void;
}) {
  // The first page only (the gateway lists at most 100 options per page).
  const options = useBrainLoad(() => api.sourceOptions(projectId, kind, {}), kind);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [text, setText] = useState("");
  const [label, setLabel] = useState("");
  const [settings, setSettings] = useState(BRAIN_SOURCE_DEFAULT_SETTINGS);
  const submitter = useConnectSubmit({ api, projectId, kind, onConnected });
  const draft = connectDraft(kind, options.state, picked, text, settings);
  const max = BRAIN_SOURCE_CHOICES_MAX[kind];

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (draft.ready && draft.values !== null) submitter.connect(draft.values, settings, label);
  };

  return (
    <form onSubmit={submit} className="grid gap-3">
      {draft.typedInput ? (
        <TypedChoice input={draft.typedInput} text={text} values={draft.values} max={max} onChange={setText} />
      ) : (
        <OptionChoices state={options.state} onRetry={options.reload} max={max} picked={picked}
          onToggle={(id, on) => setPicked(nextPicked(picked, id, on, max))} />
      )}
      <BrainSourceSettingsForm kind={kind} settings={settings} onChange={setSettings} />
      <BrainInput aria-label="Name (optional)" placeholder="Name (optional)" maxLength={LABEL_MAX_CHARS} value={label}
        onChange={(event) => setLabel(event.target.value)} />
      <BrainButton type="submit" size="sm" className="justify-self-start" disabled={!draft.ready || submitter.busy}>
        {submitter.busy ? "Connecting..." : "Connect"}
      </BrainButton>
      {submitter.error && <BrainError error={submitter.error} />}
    </form>
  );
}

function typedHint(values: readonly string[] | null, max: number, hint: string): string {
  if (values === null) return "Check what you typed.";
  return values.length > max ? `Up to ${max}.` : hint;
}

/** The typed value of a kind that lists no options. */
function TypedChoice({ input, text, values, max, onChange }: {
  readonly input: BrainTypedSourceInput; readonly text: string; readonly values: readonly string[] | null;
  readonly max: number; readonly onChange: (text: string) => void;
}) {
  return (
    <div className="grid gap-1 text-sm">
      <BrainInput aria-label={input.label} placeholder={input.example} maxLength={TYPED_MAX_CHARS} value={text}
        aria-invalid={values === null || values.length > max} onChange={(event) => onChange(event.target.value)} />
      <span className="text-xs text-muted-foreground">{typedHint(values, max, input.hint)}</span>
    </div>
  );
}

/** The listed options: radios for a single-choice kind, else checkboxes up to `max`. */
function OptionChoices({ state, onRetry, max, picked, onToggle }: {
  readonly state: BrainLoad<BrainSourceOptionsView>; readonly onRetry: () => void; readonly max: number;
  readonly picked: readonly string[]; readonly onToggle: (id: string, on: boolean) => void;
}) {
  const chosen = new Set(picked);
  const full = max > 1 && picked.length >= max;
  return (
    <BrainView state={state} label="Loading choices..." onRetry={onRetry}>
      {(view) => view.items.length === 0 ? <BrainEmpty title="Nothing to choose from yet." /> : (
        <fieldset className="grid max-h-56 gap-1 overflow-auto">
          <legend className="mb-1 text-sm font-medium">
            {max === 1 ? "Choose one" : `Choose what to include (up to ${max})`}
          </legend>
          {view.items.map((option) => (
            <OptionChoice key={option.id} option={option} single={max === 1} checked={chosen.has(option.id)}
              disabled={full && !chosen.has(option.id)} onToggle={onToggle} />
          ))}
          {view.nextCursor !== null && (
            <p className="text-xs text-muted-foreground">Only the first {view.items.length} are shown.</p>
          )}
        </fieldset>
      )}
    </BrainView>
  );
}

function OptionChoice({ option, single, checked, disabled, onToggle }: {
  readonly option: BrainSourceOptionView; readonly single: boolean; readonly checked: boolean;
  readonly disabled: boolean; readonly onToggle: (id: string, on: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type={single ? "radio" : "checkbox"}
        name="brain-source-option"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onToggle(option.id, event.target.checked)}
      />
      <span>{option.label}</span>
      {option.detail && <span className="text-xs text-muted-foreground">{option.detail}</span>}
    </label>
  );
}
