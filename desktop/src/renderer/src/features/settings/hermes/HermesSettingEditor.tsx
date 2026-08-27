import type { HermesConfigField } from "@matrix-os/contracts";
import { RotateCcw } from "@renderer/lib/hugeicons";
import { useEffect, useState } from "react";
import { Button } from "../../../design/primitives";
import { parseHermesList, titleCase, valuesEqual } from "./hermes-form-model";

interface HermesSettingEditorProps {
  path: string;
  field: HermesConfigField;
  value: unknown;
  defaultValue: unknown;
  onChange: (value: string | number | boolean | Array<string | number | boolean>) => void;
  onValidityChange: (valid: boolean) => void;
}

const INPUT_CLASS = "mt-2 min-h-9 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none focus:border-[var(--accent)]";

export function HermesSettingEditor({
  path,
  field,
  value,
  defaultValue,
  onChange,
  onValidityChange,
}: HermesSettingEditorProps) {
  const label = field.description || titleCase(path.split(".").at(-1) ?? path);
  const [listText, setListText] = useState(() => JSON.stringify(value ?? [], null, 2));
  const [listValid, setListValid] = useState(true);

  useEffect(() => {
    if (field.type === "list") {
      setListText(JSON.stringify(value ?? [], null, 2));
      setListValid(true);
      onValidityChange(true);
    }
  // Reset the textual list draft when its authoritative value changes. The
  // callback is intentionally excluded: parents provide a render-local setter
  // and including it would turn a reset into a render loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field.type, path, value]);

  const restore = () => {
    if (field.type === "list") {
      const next = Array.isArray(defaultValue) ? defaultValue as Array<string | number | boolean> : [];
      setListText(JSON.stringify(next, null, 2));
      setListValid(true);
      onValidityChange(true);
      onChange(next);
      return;
    }
    if (typeof defaultValue === "string" || typeof defaultValue === "number" || typeof defaultValue === "boolean") {
      onValidityChange(true);
      onChange(defaultValue);
    }
  };

  let control;
  if (field.type === "boolean") {
    control = (
      <label className="mt-2 flex items-center gap-2 text-sm" style={{ color: "var(--text-secondary)" }}>
        <input
          aria-label={label}
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {Boolean(value) ? "Enabled" : "Disabled"}
      </label>
    );
  } else if (field.type === "select") {
    control = (
      <select
        aria-label={label}
        className={INPUT_CLASS}
        style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      >
        {field.options?.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  } else if (field.type === "number") {
    control = (
      <input
        aria-label={label}
        type="number"
        className={INPUT_CLASS}
        style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
        value={typeof value === "number" ? value : ""}
        onChange={(event) => {
          const next = event.target.valueAsNumber;
          const valid = Number.isFinite(next);
          onValidityChange(valid);
          if (valid) onChange(next);
        }}
      />
    );
  } else if (field.type === "list") {
    control = (
      <>
        <textarea
          aria-label={label}
          className={`${INPUT_CLASS} min-h-24 py-2 font-mono text-xs`}
          style={{ borderColor: listValid ? "var(--border-default)" : "var(--danger)", color: "var(--text-primary)" }}
          value={listText}
          onChange={(event) => {
            const text = event.target.value;
            const parsed = parseHermesList(text);
            setListText(text);
            setListValid(parsed !== null);
            onValidityChange(parsed !== null);
            if (parsed) onChange(parsed);
          }}
        />
        {!listValid ? (
          <p role="alert" className="mt-1 text-xs" style={{ color: "var(--danger)" }}>
            Enter a JSON list of strings, numbers, or booleans.
          </p>
        ) : null}
      </>
    );
  } else {
    control = (
      <input
        aria-label={label}
        type="text"
        className={INPUT_CLASS}
        style={{ borderColor: "var(--border-default)", color: "var(--text-primary)" }}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  }

  return (
    <article className="rounded-lg border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-sunken)" }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="block text-sm font-medium" style={{ color: "var(--text-primary)" }}>{label}</span>
          <code className="text-xs" style={{ color: "var(--text-tertiary)" }}>{path}</code>
        </div>
        <Button
          variant="ghost"
          className="h-7 w-7 px-0"
          aria-label={`Restore ${label} to default`}
          disabled={valuesEqual(value, defaultValue)}
          onClick={restore}
        >
          <RotateCcw size={14} />
        </Button>
      </div>
      {control}
    </article>
  );
}
