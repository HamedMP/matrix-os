import { useEffectEvent, useLayoutEffect, useState } from "react";
import type { ProjectSetupDraft } from "@matrix-os/contracts";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProjectSetupActionButton as Action, borderStyle, mutedStyle } from "./ProjectSetupAction.js";

export interface ProjectSetupMarkdownState {
  value: string;
  baseline: string;
  mode: "preview" | "edit";
}

// The transcript can move the review to another message after an individual file is applied.
export function useProjectSetupMarkdownEdits(scope: string, proposals?: ProjectSetupDraft["proposals"]) {
  const [editors, setEditors] = useState<{ scope: string; files: Record<string, ProjectSetupMarkdownState> }>({
    scope, files: {},
  });
  useLayoutEffect(() => {
    setEditors({ scope, files: {} });
  }, [scope]);
  return {
    files: editors.scope === scope ? editors.files : {},
    onChange: (path: string, state: ProjectSetupMarkdownState) => setEditors(previous => {
      const paths = proposals?.map(file => file.path) ?? [];
      if (previous.scope !== scope || !paths.includes(path)) return previous;
      const files = Object.fromEntries(Object.entries(previous.files).filter(([key]) => paths.includes(key)));
      return { scope, files: { ...files, [path]: state } };
    }),
  };
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
  const [baseline, setBaseline] = useState(initialState?.value === content ? content : initialState?.baseline ?? content);
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
    <section className="min-w-0" aria-label={`Review ${path}`}>
      <div
        className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2"
        style={borderStyle}
      >
        <span className="min-w-0 font-mono text-xs font-medium [overflow-wrap:anywhere]">{path}</span>
        <div className="flex flex-wrap gap-2">
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
          className="block min-h-56 w-full rounded-none border-0 bg-transparent p-4 font-mono text-sm leading-relaxed"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onDirtyChange(event.target.value !== baseline);
          }}
          disabled={busy}
          maxLength={65536}
        />
      ) : (
        <div className="max-h-80 space-y-3 overflow-auto px-4 py-3 text-sm leading-relaxed [overflow-wrap:anywhere] [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-medium [&_ol]:list-decimal [&_ul]:list-disc [&_ol]:pl-5 [&_ul]:pl-5 [&_pre]:overflow-x-auto">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
        </div>
      )}
      {tooLong ? (
        <p role="alert" className="px-4 pb-3 text-xs" style={mutedStyle}>
          {value.length} / {maximumCharacters} characters. Shorten this draft before saving.
        </p>
      ) : null}
      {dirty ? (
        <p className="px-4 pb-3 text-xs" style={mutedStyle}>
          Apply these draft changes before saving project setup.
        </p>
      ) : null}
    </section>
  );
}
