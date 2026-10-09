import { useState } from "react";

import { Sheet } from "@/components/ui";

import { ProjectMenu } from "./ProjectMenu";
import { ProjectNameForm } from "./ProjectNameForm";

export type ProjectOptionsPage = "menu" | "rename";

export interface ProjectOptionsSheetProps {
  /** What the sheet shows: the menu, or the rename form that takes its place. Null closes it. */
  page: ProjectOptionsPage | null;
  name: string;
  /** When the project last changed, already worded. */
  updated?: string;
  archiving: boolean;
  renaming: boolean;
  /** What to say under the name field about the last rename, when it failed. */
  renameFailure?: string | null;
  /** Rename was chosen in the menu. */
  onRename: () => void;
  onArchive: () => void;
  onSubmitName: (name: string) => void;
  onClose: () => void;
}

/**
 * The sheet opened from a project's "…": its menu and, from there, the rename
 * form. Both live in one sheet, because a second sheet cannot be opened safely
 * while the first is still on its way out.
 */
export function ProjectOptionsSheet({
  page,
  name,
  updated,
  archiving,
  renaming,
  renameFailure,
  onRename,
  onArchive,
  onSubmitName,
  onClose,
}: ProjectOptionsSheetProps) {
  // The page last shown stays drawn while the sheet slides away, and each
  // time the rename form is shown it starts from the name as it is then.
  const [shown, setShown] = useState({ current: page, drawn: page, showing: 0 });
  if (page !== shown.current) {
    setShown({ current: page, drawn: page ?? shown.drawn, showing: page ? shown.showing + 1 : shown.showing });
  }

  return (
    <Sheet visible={page !== null} onClose={onClose} testID="project-options-sheet">
      {shown.drawn === "menu" ? (
        <ProjectMenu name={name} updated={updated} busy={archiving} onRename={onRename} onArchive={onArchive} />
      ) : shown.drawn === "rename" ? (
        <ProjectNameForm
          key={shown.showing}
          title="Rename project"
          confirmLabel="Save"
          initialName={name}
          saving={renaming}
          failure={renameFailure}
          onSubmit={onSubmitName}
          onCancel={onClose}
        />
      ) : null}
    </Sheet>
  );
}
