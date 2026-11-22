import { useEffectEvent, useLayoutEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";

export interface ProjectSetupMarkdownState {
  value: string;
  baseline: string;
  mode: "preview" | "edit";
}

export function ProjectSetupMarkdown({
  path,
  content,
  busy,
  onApply,
  onDirtyChange,
  editable,
  initialState,
  onStateChange,
  maximumCharacters,
}: {
  maximumCharacters?: number;
  initialState?: ProjectSetupMarkdownState;
  onStateChange?: (state: ProjectSetupMarkdownState) => void;
  path: string;
  content: string;
  busy: boolean;
  editable: boolean;
  onApply: (content: string) => Promise<boolean>;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const [value, setValue] = useState(initialState?.value ?? content);
  const [mode, setMode] = useState<"preview" | "edit">(initialState?.mode ?? "preview");
  const [baseline, setBaseline] = useState(initialState?.baseline ?? content);
  const dirty = value !== baseline;
  const tooLong = maximumCharacters !== undefined && value.length > maximumCharacters;
  if (content !== baseline && !dirty) {
    setBaseline(content);
    setValue(content);
  }
  const persistEditor = useEffectEvent((state: ProjectSetupMarkdownState) => onStateChange?.(state));
  useLayoutEffect(() => {
    persistEditor({ value, baseline, mode });
  }, [value, baseline, mode]);
  const apply = async () => {
    if (await onApply(value)) {
      setBaseline(value);
      onDirtyChange(false);
    }
  };
  return (
    <section className="overflow-hidden rounded-lg border" style={borderStyle} aria-label={`Review ${path}`}>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2"
        style={borderStyle}
      >
        <span className="break-all font-mono text-xs">{path}</span>
        <div className="flex gap-2">
          {editable ? (
            <Action onClick={() => {
              const nextMode = mode === "edit" ? "preview" : "edit";
              setMode(nextMode);
            }}>
              {mode === "edit" ? "Preview" : "Edit Markdown"}
            </Action>
          ) : null}
          {dirty ? (
            <Action
              disabled={busy || !value.trim() || tooLong}
              onClick={() => {
                void apply();
              }}
            >
              Apply draft changes
            </Action>
          ) : null}
        </div>
      </div>
      {mode === "edit" ? (
        <textarea
          aria-label={`Markdown for ${path}`}
          className="min-h-56 w-full rounded-none border-0 bg-transparent p-3 font-mono text-xs"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onDirtyChange(event.target.value !== baseline);
          }}
          disabled={busy}
          maxLength={65536}
        />
      ) : (
        <div className="max-h-80 overflow-y-auto p-3 text-sm leading-relaxed [&_h1]:mb-3 [&_h1]:font-semibold [&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:font-medium [&_li]:ml-4 [&_ul]:list-disc [&_p]:my-2">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
        </div>
      )}
      {tooLong ? (
        <p role="alert" className="px-3 pb-3 text-xs" style={mutedStyle}>
          {value.length} / {maximumCharacters} characters. Shorten this draft before saving.
        </p>
      ) : null}
      {dirty ? (
        <p className="px-3 pb-3 text-xs" style={mutedStyle}>
          Apply these draft changes before saving project setup.
        </p>
      ) : null}
    </section>
  );
}
