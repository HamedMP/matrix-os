import { useState, type RefObject } from "react";
import { Button, Dialog } from "../../../design/primitives";
import type { Project } from "../../../stores/board";
import { InspectorFilesPanel } from "../../panels/InspectorFilesPanel";

export function ProjectEditDialog({ project, pending, error, onClose, onSave, returnFocusRef }: {
  project: Project;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  pending: boolean;
  error: string | null;
  onClose(): void;
  onSave(patch: { name: string; description: string }): Promise<boolean>;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  return <Dialog open title="Edit project" onClose={() => { if (!pending) onClose(); }} width={440} onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
    <form className="space-y-4 p-5" onSubmit={event => {
      event.preventDefault();
      if (!name.trim() || pending) return;
      void onSave({ name: name.trim(), description: description.trim() }).then(saved => { if (saved) onClose(); });
    }}>
      <h2 className="text-base font-semibold">Edit project</h2>
      <label className="block text-sm">Project name
        <input autoFocus className="mt-1 w-full rounded-md border bg-transparent p-2" value={name} maxLength={128} disabled={pending} onChange={event => setName(event.target.value)} />
      </label>
      <label className="block text-sm">Description
        <textarea className="mt-1 w-full rounded-md border bg-transparent p-2" value={description} maxLength={1000} disabled={pending} onChange={event => setDescription(event.target.value)} />
      </label>
      {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger)" }}>{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button disabled={pending} onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
      </div>
    </form>
  </Dialog>;
}

export function ProjectFilesDialog({ project, onClose, returnFocusRef }: { project: Project; onClose(): void; returnFocusRef: RefObject<HTMLButtonElement | null> }) {
  return <Dialog open title={`Files — ${project.name}`} onClose={onClose} width={760} onCloseAutoFocus={event => { event.preventDefault(); returnFocusRef.current?.focus(); }}>
    <div className="flex items-center justify-between border-b p-3">
      <h2 className="truncate font-medium">Files — {project.name}</h2>
      <Button onClick={onClose}>Close</Button>
    </div>
    <div className="flex h-[60vh] min-h-0 flex-col overflow-auto p-3">
      <InspectorFilesPanel scope={{ kind: "project", projectId: project.slug, chatId: `project-files:${project.id ?? project.slug}`, label: project.name }} />
    </div>
  </Dialog>;
}
