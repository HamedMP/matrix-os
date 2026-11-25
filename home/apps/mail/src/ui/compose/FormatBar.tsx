/**
 * The composer toolbar: text formatting, links, "Suggest edits" and the
 * assistant. Formatting buttons keep the editor's selection (mousedown does
 * not take focus) and run through the editor handle.
 */
import { useRef, useState, type ReactNode, type RefObject } from "react";
import { Bold, Italic, Link2, List, ListOrdered, PenLine, Quote, Sparkles, Underline } from "lucide-react";
import { Popover, Spinner, TextField, Toolbar, ToolbarButton, ToolbarGroup, ToolbarSeparator } from "../../../../_shared/office-ui";
import { linkTarget } from "../../compose/paste";
import type { EditorCommand, RichEditorHandle } from "./RichEditor";

export interface FormatBarProps {
  editor: RefObject<RichEditorHandle | null>;
  suggesting: boolean;
  onSuggesting(on: boolean): void;
  /** Null when the host has no assistant. */
  assistant: null | {
    busy: boolean;
    /** True when the body is empty: the assistant writes instead of rewriting. */
    writing: boolean;
    onRun(instruction: string): void;
    onCancel(): void;
  };
  linkOpen: boolean;
  onLinkOpen(open: boolean): void;
}

const keep = (event: { preventDefault(): void }) => event.preventDefault();

export function FormatBar({ editor, suggesting, onSuggesting, assistant, linkOpen, onLinkOpen }: FormatBarProps) {
  const linkRef = useRef<HTMLButtonElement>(null);
  const aiRef = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState<string | undefined>();
  const [aiOpen, setAiOpen] = useState(false);
  const [instruction, setInstruction] = useState("");

  const run = (command: EditorCommand) => editor.current?.run(command);
  const format = (label: string, command: EditorCommand, icon: ReactNode, shortcut?: string) => (
    <ToolbarButton label={label} icon={icon} shortcut={shortcut} onMouseDown={keep} onClick={() => run(command)} />
  );

  const applyLink = () => {
    const target = linkTarget(url);
    if (!target) {
      setUrlError("Use a web address (https://…) or an email address.");
      return;
    }
    editor.current?.link(target);
    setUrl("");
    setUrlError(undefined);
    onLinkOpen(false);
  };

  const runAssistant = () => {
    if (!assistant) return;
    assistant.onRun(instruction);
    setAiOpen(false);
  };

  return (
    <Toolbar label="Formatting" className="mail-compose__toolbar">
      <ToolbarGroup label="Text">
        {format("Bold", "bold", <Bold size={15} />, "Ctrl+B")}
        {format("Italic", "italic", <Italic size={15} />, "Ctrl+I")}
        {format("Underline", "underline", <Underline size={15} />, "Ctrl+U")}
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Paragraph">
        {format("Bulleted list", "bulletList", <List size={15} />)}
        {format("Numbered list", "numberedList", <ListOrdered size={15} />)}
        {format("Quote", "quote", <Quote size={15} />)}
        <ToolbarButton ref={linkRef} label="Link" icon={<Link2 size={15} />} shortcut="Ctrl+K" onMouseDown={keep} onClick={() => onLinkOpen(!linkOpen)} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarGroup label="Review">
        <ToolbarButton
          label="Suggest edits"
          icon={<PenLine size={15} />}
          showLabel
          pressed={suggesting}
          onClick={() => onSuggesting(!suggesting)}
        />
        {assistant && (
          assistant.busy ? (
            <ToolbarButton label="Stop assistant" icon={<Spinner size={14} label="Assistant is writing" />} showLabel onClick={assistant.onCancel} />
          ) : (
            <ToolbarButton ref={aiRef} label={assistant.writing ? "Write with assistant" : "Rewrite"} icon={<Sparkles size={15} />} showLabel onClick={() => setAiOpen((open) => !open)} />
          )
        )}
      </ToolbarGroup>
      <Popover open={linkOpen} onClose={() => onLinkOpen(false)} anchorRef={linkRef} label="Add link">
        <form
          className="mail-compose__popover-form"
          onSubmit={(event) => {
            event.preventDefault();
            applyLink();
          }}
        >
          <TextField label="Link address" value={url} onChange={setUrl} placeholder="https://" error={urlError} autoFocus />
          <button type="submit" className="oui-button oui-button--primary">Add link</button>
        </form>
      </Popover>
      {assistant && (
        <Popover open={aiOpen} onClose={() => setAiOpen(false)} anchorRef={aiRef} label={assistant.writing ? "Write with assistant" : "Rewrite with assistant"}>
          <form
            className="mail-compose__popover-form"
            onSubmit={(event) => {
              event.preventDefault();
              runAssistant();
            }}
          >
            <TextField
              label={assistant.writing ? "What should the message say?" : "How should it change?"}
              value={instruction}
              onChange={setInstruction}
              placeholder={assistant.writing ? "Accept the meeting and suggest Thursday" : "Shorter and warmer"}
              maxLength={2000}
              autoFocus
            />
            <p className="mail-compose__hint">The assistant's text appears as tracked changes for you to review.</p>
            <button type="submit" className="oui-button oui-button--primary"><Sparkles size={14} aria-hidden="true" /> Ask assistant</button>
          </form>
        </Popover>
      )}
    </Toolbar>
  );
}
