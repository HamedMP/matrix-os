import { useState, type ComponentType, type ReactNode } from "react";

export interface ProjectEditButtonProps {
  variant: "subtle" | "primary";
  type: "button" | "submit";
  disabled?: boolean;
  onClick?(): void;
  children: ReactNode;
}

/** Body of the "Edit project" dialog; the OS view owns the chrome and the request. */
export function ProjectEditForm({ project, pending, error, Button, onClose, onSave }: {
  project: { name: string; description?: string };
  pending: boolean;
  error: string | null;
  Button: ComponentType<ProjectEditButtonProps>;
  onClose(): void;
  onSave(patch: { name: string; description: string }): Promise<boolean>;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const submit = async () => {
    if (!name.trim() || pending) return;
    if (await onSave({ name: name.trim(), description: description.trim() })) onClose();
  };
  return <form className="space-y-4 p-5" onSubmit={event => {
    event.preventDefault();
    void submit();
  }}>
    <h2 className="text-base font-semibold">Edit project</h2>
    <label className="block text-sm">Project name
      <input
        // react-doctor-disable-next-line react-doctor/no-autofocus -- the dialog opens only from the explicit Edit action; its first field takes focus as in Electron Desktop
        autoFocus className="mt-1 w-full rounded-md border bg-transparent p-2" value={name} maxLength={128} disabled={pending} onChange={event => setName(event.target.value)} />
    </label>
    <label className="block text-sm">Description
      <textarea className="mt-1 w-full rounded-md border bg-transparent p-2" value={description} maxLength={1000} disabled={pending} onChange={event => setDescription(event.target.value)} />
    </label>
    {error ? <p role="alert" className="text-sm" style={{ color: "var(--danger-text, var(--destructive))" }}>{error}</p> : null}
    <div className="flex justify-end gap-2">
      <Button variant="subtle" type="button" disabled={pending} onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={pending || !name.trim()}>{pending ? "Saving…" : "Save"}</Button>
    </div>
  </form>;
}
