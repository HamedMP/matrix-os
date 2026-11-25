/**
 * What Sheets shows with no workbook open: pick up a recent file, browse the
 * owner's Matrix home, bring a file from this computer, or start from a
 * template.
 */
import { ClipboardPaste } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { OfficeStartScreen, type StartFolderMemory, type StartTemplate } from "../../../_shared/office-ui";
import type { RecentFile, RecentFiles } from "../session";
import type { SheetsBridge } from "./bridge";
import { LOCAL_ACCEPT } from "./document-flow";
import { sheetKind } from "./sheet-kind";
import { templateArt } from "./template-art";
import { SHEETS_TEMPLATES, type SheetsTemplateId, sheetsTemplate } from "./templates";

/** The launcher artwork, shown where the app introduces itself. */
const appArtwork = new URL("../../../../system/icons/v3-sheets.png", import.meta.url).href;

const TEMPLATES: readonly StartTemplate[] = SHEETS_TEMPLATES.map((template) => ({
  id: template.id,
  label: template.label,
  description: template.description,
  preview: templateArt(template.id),
}));

export interface StartScreenProps {
  recents: RecentFiles;
  files: SheetsBridge["files"];
  /** Remembers the folder the owner last browsed. */
  folderMemory?: StartFolderMemory;
  /** Path being opened, shown as busy. */
  opening: string | null;
  onTemplate: (id: SheetsTemplateId) => void;
  /** Opens the system file chooser. */
  onOpenLocal: () => void;
  onImport: () => void;
  onOpenPath: (path: string) => void;
}

export function StartScreen({ recents, files, folderMemory, opening, onTemplate, onOpenLocal, onImport, onOpenPath }: StartScreenProps) {
  const [list, setList] = useState<RecentFile[] | null>(null);

  useEffect(() => {
    let live = true;
    // `list()` never rejects: it logs and returns an empty list.
    void recents.list().then((entries) => {
      if (live) setList(entries);
    });
    return () => {
      live = false;
    };
  }, [recents]);

  const remove = useCallback(
    async (path: string) => {
      // The list shows what the table holds after the delete, so a failed delete keeps the entry.
      await recents.remove(path);
      setList(await recents.list());
    },
    [recents],
  );

  return (
    <OfficeStartScreen
      className="sheets-start"
      appName="Sheets"
      artwork={appArtwork}
      busy={opening !== null}
      create={{
        heading: "Start a new workbook",
        templates: TEMPLATES,
        onCreate: (id) => {
          const template = sheetsTemplate(id);
          if (template !== null) onTemplate(template.id);
        },
        more: [{ id: "import", label: "Import CSV…", icon: <ClipboardPaste />, onClick: onImport }],
      }}
      local={{ accept: LOCAL_ACCEPT, noun: "a spreadsheet", onChoose: onOpenLocal }}
      recents={{
        heading: "Recent workbooks",
        items: list ?? [],
        loading: list === null,
        opening,
        onOpen: onOpenPath,
        onRemove: remove,
        emptyHeadline: "No recent workbooks",
        emptyDescription: "Workbooks you open or save appear here, so you can pick them up again.",
      }}
      browser={{ files, accept: LOCAL_ACCEPT, onOpen: onOpenPath, fileNoun: "spreadsheets", memory: folderMemory }}
      kindOf={sheetKind}
    />
  );
}
