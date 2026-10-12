import { useState } from "react";

import { Sheet } from "@/components/ui";

import { ProjectNameForm, type ProjectNameFormProps } from "./ProjectNameForm";

export interface ProjectNameSheetProps extends ProjectNameFormProps {
  visible: boolean;
}

/** The short sheet that names a project. Dragging it away cancels it. */
export function ProjectNameSheet({ visible, ...form }: ProjectNameSheetProps) {
  // Each opening starts a new form; the last one stays drawn while the sheet slides away.
  const [shown, setShown] = useState({ visible, opening: 0 });
  if (visible !== shown.visible) {
    setShown({ visible, opening: visible ? shown.opening + 1 : shown.opening });
  }

  return (
    <Sheet visible={visible} onClose={form.onCancel} testID="project-name-sheet">
      <ProjectNameForm key={shown.opening} {...form} />
    </Sheet>
  );
}
