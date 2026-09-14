import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Markdown } from "@tiptap/markdown";
import type { Note, NotesController } from "./notes-controller";
import "./notes.css";

function exitEmptyChecklistItem(editor: Editor | null): boolean {
  if (!editor) return false;
  const { selection } = editor.state;
  if (!selection.empty) return false;

  let taskDepth = -1;
  for (let depth = selection.$from.depth; depth > 0; depth -= 1) {
    if (selection.$from.node(depth).type.name === "taskItem") {
      taskDepth = depth;
      break;
    }
  }
  if (taskDepth < 0 || selection.$from.node(taskDepth).textContent.length > 0) return false;

  let lifted = false;
  for (let depth = 0; depth < 20 && editor.isActive("taskItem"); depth += 1) {
    if (!editor.commands.liftListItem("taskItem")) break;
    lifted = true;
  }
  return lifted;
}

export default function NoteEditor({ note, controller }: { note: Note; controller: NotesController }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
    ],
    content: note.content_json ?? note.content,
    ...(!note.content_json ? { contentType: "markdown" as const } : {}),
    autofocus: !note.title && !note.content ? "end" : false,
    editorProps: { attributes: { class: "notes-editor", "aria-label": "Note body", spellcheck: "true" } },
    onUpdate: ({ editor: current }) => controller.edit(note.id, {
      content_json: current.getJSON(), content: current.getMarkdown(),
    }),
    onBlur: () => { void controller.flush(); },
  });

  return (
    <div className="w-full px-6">
      <input
        aria-label="Note title"
        value={note.title}
        maxLength={240}
        placeholder="Untitled"
        className="notes-title mb-2 w-full border-0 bg-transparent text-[30px] font-semibold leading-[38px] tracking-[-0.8px] outline-none placeholder:text-[var(--text-subtle)]"
        style={{ color: "var(--text-primary)" }}
        onChange={(event) => controller.edit(note.id, { title: event.currentTarget.value })}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); editor?.commands.focus("start"); } }}
        onBlur={() => { void controller.flush(); }}
      />
      <div
        onKeyDownCapture={(event) => {
          if (event.key !== "Enter" && event.key !== "Backspace") return;
          if (!exitEmptyChecklistItem(editor)) return;
          // Run before ProseMirror's TaskItem shortcut, which otherwise always
          // splits the item and leaves the cursor trapped in checklist mode.
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
