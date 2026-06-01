import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  List,
  ListOrdered,
  Quote,
  Slash,
  Strikethrough,
} from "lucide-react";
import { htmlToMarkdown, markdownToHtml } from "./markdown";
import { emptyTiptapDoc, type Note, type TiptapDoc } from "./notes-model";

type SlashCommand = {
  id: string;
  label: string;
  hint: string;
  icon: typeof Heading1;
  run: (editor: Editor) => void;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "h1", label: "Heading 1", hint: "Large section title", icon: Heading1, run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", hint: "Medium section title", icon: Heading2, run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "h3", label: "Heading 3", hint: "Small section title", icon: Heading3, run: (e) => e.chain().focus().toggleHeading({ level: 3 }).run() },
  { id: "ul", label: "Bullet list", hint: "Simple bulleted list", icon: List, run: (e) => e.chain().focus().toggleBulletList().run() },
  { id: "ol", label: "Numbered list", hint: "Ordered list", icon: ListOrdered, run: (e) => e.chain().focus().toggleOrderedList().run() },
  { id: "quote", label: "Quote", hint: "Capture a quote", icon: Quote, run: (e) => e.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", hint: "Monospaced code", icon: Code, run: (e) => e.chain().focus().toggleCodeBlock().run() },
];

export interface RichEditorProps {
  note: Note;
  onChange: (patch: { content: string; content_json: TiptapDoc }) => void;
}

export default function RichEditor({ note, onChange }: RichEditorProps) {
  const [mode, setMode] = useState<"rich" | "source">("rich");
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashIndex, setSlashIndex] = useState(0);
  const lastAppliedNoteIdRef = useRef<string | null>(null);
  const slashMenuRef = useRef<HTMLDivElement | null>(null);

  const closeSlash = useCallback(() => {
    setSlashOpen(false);
    setSlashQuery("");
    setSlashIndex(0);
  }, []);

  const editor = useEditor({
    extensions: [StarterKit],
    content: note.content_json.content?.length ? note.content_json : markdownToHtml(note.content),
    immediatelyRender: false,
    editorProps: {
      attributes: { class: "rich-editor-content", "aria-label": "Note body" },
    },
    onUpdate({ editor: activeEditor }) {
      onChange({
        content: htmlToMarkdown(activeEditor.getHTML()),
        content_json: activeEditor.getJSON() as TiptapDoc,
      });
    },
  });

  useEffect(() => {
    if (!editor || lastAppliedNoteIdRef.current === note.id) return;
    lastAppliedNoteIdRef.current = note.id;
    closeSlash();
    editor.commands.setContent(
      note.content_json.content?.length ? note.content_json : markdownToHtml(note.content),
      { emitUpdate: false },
    );
  }, [closeSlash, editor, note.content, note.content_json, note.id]);

  const filteredCommands = useMemo(() => {
    const q = slashQuery.trim().toLowerCase();
    if (!q) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((cmd) => cmd.label.toLowerCase().includes(q) || cmd.id.includes(q));
  }, [slashQuery]);

  useEffect(() => {
    if (!slashOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && slashMenuRef.current?.contains(target)) return;
      closeSlash();
    };

    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [closeSlash, slashOpen]);

  const applyCommand = useCallback(
    (command: SlashCommand) => {
      if (editor) command.run(editor);
      closeSlash();
      editor?.commands.focus();
    },
    [editor, closeSlash],
  );

  const updateMarkdownSource = useCallback(
    (markdown: string) => {
      if (!editor) {
        onChange({ content: markdown, content_json: emptyTiptapDoc() });
        return;
      }
      editor.commands.setContent(markdownToHtml(markdown), { emitUpdate: false });
      onChange({ content: markdown, content_json: editor.getJSON() as TiptapDoc });
    },
    [editor, onChange],
  );

  const handleEditorKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!slashOpen) {
        if (event.key === "/" && editor?.isFocused) {
          event.preventDefault();
          setSlashOpen(true);
          setSlashQuery("");
          setSlashIndex(0);
        }
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSlash();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSlashIndex((i) => (i + 1) % Math.max(filteredCommands.length, 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % Math.max(filteredCommands.length, 1));
        return;
      }
      if (event.key === "Enter") {
        const command = filteredCommands[slashIndex];
        if (command) {
          event.preventDefault();
          applyCommand(command);
        }
      }
    },
    [slashOpen, editor, closeSlash, filteredCommands, slashIndex, applyCommand],
  );

  const btn = (active: boolean) => (active ? "format-button format-button--active" : "format-button");

  return (
    <div className="markdown-editor">
      <div className="format-toolbar" aria-label="Formatting toolbar">
        <div className="mode-toggle" role="tablist" aria-label="Editor mode">
          <button className={mode === "rich" ? "mode-button mode-button--active" : "mode-button"} type="button" role="tab" aria-selected={mode === "rich"} onClick={() => setMode("rich")}>Rich</button>
          <button className={mode === "source" ? "mode-button mode-button--active" : "mode-button"} type="button" role="tab" aria-selected={mode === "source"} onClick={() => setMode("source")}>Markdown</button>
        </div>
        <span className="format-divider" />
        <button className={btn(!!editor?.isActive("heading", { level: 1 }))} type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} title="Heading 1"><Heading1 size={15} /></button>
        <button className={btn(!!editor?.isActive("heading", { level: 2 }))} type="button" onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} title="Heading 2"><Heading2 size={15} /></button>
        <button className={btn(!!editor?.isActive("bold"))} type="button" onClick={() => editor?.chain().focus().toggleBold().run()} title="Bold"><Bold size={15} /></button>
        <button className={btn(!!editor?.isActive("italic"))} type="button" onClick={() => editor?.chain().focus().toggleItalic().run()} title="Italic"><Italic size={15} /></button>
        <button className={btn(!!editor?.isActive("strike"))} type="button" onClick={() => editor?.chain().focus().toggleStrike().run()} title="Strikethrough"><Strikethrough size={15} /></button>
        <button className={btn(!!editor?.isActive("bulletList"))} type="button" onClick={() => editor?.chain().focus().toggleBulletList().run()} title="Bullet list"><List size={15} /></button>
        <button className={btn(!!editor?.isActive("orderedList"))} type="button" onClick={() => editor?.chain().focus().toggleOrderedList().run()} title="Numbered list"><ListOrdered size={15} /></button>
        <button className={btn(!!editor?.isActive("blockquote"))} type="button" onClick={() => editor?.chain().focus().toggleBlockquote().run()} title="Quote"><Quote size={15} /></button>
        <button className={btn(!!editor?.isActive("codeBlock"))} type="button" onClick={() => editor?.chain().focus().toggleCodeBlock().run()} title="Code block"><Code size={15} /></button>
        <span className="format-spacer" />
        <button
          className="format-button slash-trigger"
          type="button"
          onClick={() => {
            editor?.commands.focus();
            setSlashOpen(true);
            setSlashQuery("");
            setSlashIndex(0);
          }}
          title="Insert block ( / )"
        >
          <Slash size={14} />
        </button>
      </div>

      {mode === "source" ? (
        <textarea
          className="content-input"
          value={note.content}
          onChange={(event) => updateMarkdownSource(event.target.value)}
          spellCheck
          aria-label="Markdown content"
        />
      ) : (
        <div className="rich-editor-wrap" onKeyDown={handleEditorKeyDown}>
          <EditorContent editor={editor} className="rich-editor" />
          {slashOpen ? (
            <div ref={slashMenuRef} className="slash-menu" role="menu" aria-label="Insert block">
              <div className="slash-menu__search">
                <Slash size={13} />
                <input
                  autoFocus
                  value={slashQuery}
                  placeholder="Filter blocks"
                  onChange={(event) => {
                    setSlashQuery(event.target.value);
                    setSlashIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      closeSlash();
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      event.stopPropagation();
                      setSlashIndex((i) => (i + 1) % Math.max(filteredCommands.length, 1));
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      event.stopPropagation();
                      setSlashIndex((i) => (i - 1 + filteredCommands.length) % Math.max(filteredCommands.length, 1));
                    } else if (event.key === "Enter") {
                      const command = filteredCommands[slashIndex];
                      if (command) {
                        event.preventDefault();
                        event.stopPropagation();
                        applyCommand(command);
                      }
                    }
                  }}
                  aria-label="Filter blocks"
                />
              </div>
              <div className="slash-menu__list">
                {filteredCommands.map((command, index) => {
                  const Icon = command.icon;
                  return (
                    <button
                      key={command.id}
                      type="button"
                      role="menuitem"
                      className={index === slashIndex ? "slash-item slash-item--active" : "slash-item"}
                      onMouseEnter={() => setSlashIndex(index)}
                      onClick={() => applyCommand(command)}
                    >
                      <span className="slash-item__icon"><Icon size={15} /></span>
                      <span className="slash-item__text">
                        <span className="slash-item__label">{command.label}</span>
                        <span className="slash-item__hint">{command.hint}</span>
                      </span>
                    </button>
                  );
                })}
                {filteredCommands.length === 0 ? <div className="slash-empty">No blocks match</div> : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
