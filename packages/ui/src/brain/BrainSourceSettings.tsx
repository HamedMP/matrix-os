"use client";

import { useId } from "react";
import { BrainInput, BrainSelect } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BRAIN_CALENDAR_DAYS_MAX, BRAIN_FILE_SIZE_CHOICES, BRAIN_SOURCE_INCLUDE, brainSourceSettingsProblem,
  type BrainSourceSettings,
} from "./brain-format.js";
import type { BrainConnectableSourceKind } from "./brain-types.js";

const EXTENSIONS_MAX_CHARS = 400;

/** The settings of one kind beyond what to include: item types, file endings and size, calendar window. */
export function BrainSourceSettingsForm({ kind, settings, onChange }: {
  readonly kind: BrainConnectableSourceKind; readonly settings: BrainSourceSettings;
  readonly onChange: (settings: BrainSourceSettings) => void;
}) {
  const hintId = useId();
  const include = BRAIN_SOURCE_INCLUDE[kind];
  const problem = brainSourceSettingsProblem(kind, settings);
  const set = (patch: Partial<BrainSourceSettings>) => onChange({ ...settings, ...patch });
  const days = (value: string) => (value === "" ? Number.NaN : Number(value));
  if (include === undefined && kind !== "matrix_files" && kind !== "google_calendar") return null;
  return (
    <fieldset className="grid gap-2 text-sm" aria-describedby={problem === null ? undefined : hintId}>
      <legend className="mb-1 font-medium">Settings</legend>
      {include?.map(([key, label]) => (
        <label key={key} className="flex items-center gap-2">
          <input type="checkbox" checked={settings.include[key] ?? true}
            onChange={(event) => set({ include: { ...settings.include, [key]: event.target.checked } })} />
          {label}
        </label>
      ))}
      {kind === "matrix_files" && (
        <div className="grid gap-2 @md:grid-cols-2">
          <label className="grid gap-1">
            File endings
            <BrainInput value={settings.extensions} maxLength={EXTENSIONS_MAX_CHARS} placeholder="md, txt"
              aria-invalid={problem !== null} onChange={(event) => set({ extensions: event.target.value })} />
          </label>
          <label className="grid gap-1">
            Largest file
            <BrainSelect value={settings.maxFileBytes} onChange={(event) => set({ maxFileBytes: Number(event.target.value) })}>
              {BRAIN_FILE_SIZE_CHOICES.map(([bytes, text]) => <option key={bytes} value={bytes}>{text}</option>)}
            </BrainSelect>
          </label>
        </div>
      )}
      {kind === "google_calendar" && (
        <div className="grid grid-cols-2 gap-2">
          <label className="grid gap-1">
            Days back
            <BrainInput type="number" min={0} max={BRAIN_CALENDAR_DAYS_MAX}
              value={Number.isNaN(settings.pastDays) ? "" : settings.pastDays}
              aria-invalid={problem !== null} onChange={(event) => set({ pastDays: days(event.target.value) })} />
          </label>
          <label className="grid gap-1">
            Days ahead
            <BrainInput type="number" min={0} max={BRAIN_CALENDAR_DAYS_MAX}
              value={Number.isNaN(settings.futureDays) ? "" : settings.futureDays}
              aria-invalid={problem !== null} onChange={(event) => set({ futureDays: days(event.target.value) })} />
          </label>
        </div>
      )}
      {problem !== null && <span id={hintId} className={`text-xs ${BRAIN_TONE.warnText}`}>{problem}</span>}
    </fieldset>
  );
}
