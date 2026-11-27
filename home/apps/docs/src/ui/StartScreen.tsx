/**
 * The start screen: pick up a recent document, browse the owner's Matrix
 * home, bring a .docx from this computer, or start from a template.
 */

import { FileText, FileType2 } from "lucide-react";
import type { MatrixOSFiles } from "../../../_shared/matrix-os";
import { AppFrame, OfficeStartScreen, type StartFolderMemory, type StartTemplate } from "../../../_shared/office-ui";
import type { RecentFile, SessionError } from "../session/index";
// The launcher artwork, bundled as a data URL: the app frame is sandboxed with a null
// origin, and an image file requested from there shows broken.
import appArtwork from "../../../../system/icons/v3-docs.png?inline";
import { DOCS_ACCEPT } from "./accept";
import { templateArt } from "./template-art";
import { DOCS_TEMPLATES, type DocsTemplateId } from "./templates";

const BROWSE_ACCEPT: readonly string[] = [".docx"];

const TEMPLATES: readonly StartTemplate[] = DOCS_TEMPLATES.map((template) => ({
  id: template.id,
  label: template.label,
  description: template.description,
  preview: templateArt(template.id),
}));

const docKind = () => ({ kind: "document" as const });

export interface StartScreenProps {
  files: Pick<MatrixOSFiles, "list">;
  /** Remembers the folder the owner last browsed. */
  folderMemory?: StartFolderMemory;
  recents: readonly RecentFile[];
  /** The recent list is still being read. */
  recentsLoading?: boolean;
  loading: boolean;
  error: SessionError | null;
  onTemplate: (id: DocsTemplateId) => void;
  /** Opens a .docx from the owner's computer. */
  onOpenLocal: () => void;
  onNewFromMarkdown: () => void;
  /** Opens a document from the owner's home (a recent entry or a listed file). */
  onOpenPath: (path: string) => void;
  onRemoveRecent: (path: string) => Promise<void>;
}

export function StartScreen({ files, folderMemory, recents, recentsLoading, loading, error, onTemplate, onOpenLocal, onNewFromMarkdown, onOpenPath, onRemoveRecent }: StartScreenProps) {
  return (
    <AppFrame title="Docs" titleIcon={<FileText size={18} />}>
      <OfficeStartScreen
        appName="Docs"
        artwork={appArtwork}
        busy={loading}
        status={loading ? "Opening document…" : null}
        notice={
          error !== null && (
            <div role="alert" className="oui-start__alert">
              <strong>The document could not be opened.</strong>
              <span>{error.message} The file was not changed.</span>
            </div>
          )
        }
        create={{
          heading: "Start a new document",
          templates: TEMPLATES,
          onCreate: (id) => {
            const template = DOCS_TEMPLATES.find((entry) => entry.id === id);
            if (template) onTemplate(template.id);
          },
          more: [{ id: "markdown", label: "New from Markdown…", icon: <FileType2 />, onClick: onNewFromMarkdown }],
        }}
        local={{ accept: DOCS_ACCEPT, noun: "a Word document", onChoose: onOpenLocal }}
        recents={{
          heading: "Recent documents",
          items: recents,
          loading: recentsLoading,
          onOpen: onOpenPath,
          onRemove: onRemoveRecent,
          emptyHeadline: "No recent documents",
          emptyDescription: "Documents you open or save appear here, so you can pick them up again.",
        }}
        browser={{ files, accept: BROWSE_ACCEPT, onOpen: onOpenPath, fileNoun: "Word documents", memory: folderMemory }}
        kindOf={docKind}
      />
    </AppFrame>
  );
}
