"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { EyeIcon, PencilIcon, SaveIcon } from "lucide-react";

interface MarkdownEditorProps {
  content: string;
  onSave: (content: string) => void | Promise<void>;
  placeholder?: string;
  saving?: boolean;
}

export function MarkdownEditor({ content, onSave, placeholder, saving }: MarkdownEditorProps) {
  const [value, setValue] = useState(content);
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setValue(content);
    setDirty(false);
  }, [content]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
          onChange={handleChange}
          placeholder={placeholder}
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
