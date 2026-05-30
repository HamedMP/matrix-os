"use client";

import { useState, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { EyeIcon, PencilIcon, SaveIcon } from "lucide-react";

interface MarkdownEditorProps {
  content: string;
  onSave: (content: string) => void | Promise<void>;
  placeholder?: string;
  saving?: boolean;
}

export function MarkdownEditor({ content, onSave, placeholder, saving }: MarkdownEditorProps) {
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- editable draft buffer, not a mirror of `content`: seeded from the prop, then diverges as the user types, committed via onSave, and reset to `content` on the prev-prop edge below. It cannot be computed in render because it holds uncommitted user input.
  const [value, setValue] = useState(content);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [dirty, setDirty] = useState(false);
  // react-doctor-disable-next-line react-doctor/no-derived-useState, react-doctor/rerender-state-only-in-handlers -- transition tracker, not a mirror of `content`: `prevContent` IS read in render (the `content !== prevContent` guard below). It must be state, not a ref, so the corrective synchronous re-render runs and resets the draft when the incoming content changes.
  const [prevContent, setPrevContent] = useState(content);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reset the local draft when the incoming content prop changes (render-time
  // prev-prop pattern) so a fresh load discards any in-progress edits.
  if (content !== prevContent) {
    setPrevContent(content);
    setValue(content);
    setDirty(false);
  }

  const handleMarkdownChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setValue(e.target.value);
    setDirty(e.target.value !== content);
  }, [content]);

  const handleSave = useCallback(async () => {
    await onSave(value);
    setDirty(false);
  }, [value, onSave]);

  return (
    <div className="flex flex-col border border-border rounded-lg overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1.5 bg-muted/30 border-b border-border">
        <div className="flex items-center gap-1">
          <Button
            variant={mode === "edit" ? "default" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setMode("edit")}
          >
            <PencilIcon className="size-3 mr-1" />
            Edit
          </Button>
          <Button
            variant={mode === "preview" ? "default" : "ghost"}
            size="sm"
            className="h-7 text-xs"
            onClick={() => setMode("preview")}
          >
            <EyeIcon className="size-3 mr-1" />
            Preview
          </Button>
        </div>
        <div className="flex items-center gap-2">
          {dirty && (
            <span className="size-2 rounded-full bg-primary" title="Unsaved changes" />
          )}
          <Button
            size="sm"
            className="h-7 text-xs"
            onClick={handleSave}
            disabled={!dirty || saving}
          >
            <SaveIcon className="size-3 mr-1" />
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      {mode === "edit" ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleMarkdownChange}
          placeholder={placeholder}
          aria-label="Markdown editor"
          className="min-h-[300px] p-4 font-mono text-sm bg-background resize-y focus:outline-none"
          spellCheck={false}
        />
      ) : (
        <div className="min-h-[300px] p-4 prose prose-sm dark:prose-invert max-w-none">
          <pre className="whitespace-pre-wrap text-sm font-sans">{value || "Nothing here yet."}</pre>
        </div>
      )}
    </div>
  );
}
