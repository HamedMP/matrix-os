/** The File tab: a backstage with New, Open, Save, copies, Export and Close. */

import { Download, FilePlus2, FileType2, FolderOpen, HardDrive, Save, SaveAll, Share2, X } from "lucide-react";
import type { BackstageApi, RibbonBackstageTab } from "../../../../_shared/office-ui";
import type { ExportFormat } from "../exports";
import type { DocsRibbonContext } from "./types";

const EXPORTS: ReadonlyArray<{ format: ExportFormat; label: string; detail: string }> = [
  { format: "html", label: "Web page (.html)", detail: "Keeps headings, lists, tables and, in All markup, the tracked changes." },
  { format: "markdown", label: "Markdown (.md)", detail: "Plain text with headings, lists and emphasis." },
  { format: "text", label: "Plain text (.txt)", detail: "The words only." },
];

function NewPane({ ctx, api }: { ctx: DocsRibbonContext; api: BackstageApi }) {
  const run = (action: () => void) => {
    api.close();
    action();
  };
  return (
    <section className="docs-backstage" aria-labelledby="docs-backstage-new">
      <h2 id="docs-backstage-new" className="docs-backstage__heading">
        New
      </h2>
      <div className="docs-backstage__cards">
        <button type="button" className="docs-start__card" onClick={() => run(ctx.actions.newBlank)}>
          <FilePlus2 size={22} aria-hidden="true" />
          <span className="docs-start__card-title">Blank document</span>
          <span className="docs-muted">An empty Word document.</span>
        </button>
        <button type="button" className="docs-start__card" onClick={() => run(ctx.actions.newFromMarkdown)}>
          <FileType2 size={22} aria-hidden="true" />
          <span className="docs-start__card-title">From Markdown…</span>
          <span className="docs-muted">Paste Markdown to start a document.</span>
        </button>
      </div>
    </section>
  );
}

function ExportPane({ ctx, api }: { ctx: DocsRibbonContext; api: BackstageApi }) {
  return (
    <section className="docs-backstage" aria-labelledby="docs-backstage-export">
      <h2 id="docs-backstage-export" className="docs-backstage__heading">
        Export
      </h2>
      <p className="docs-muted">Downloads a copy in another format. The document itself is not changed.</p>
      <div className="docs-backstage__cards">
        {EXPORTS.map((entry) => (
          <button
            key={entry.format}
            type="button"
            className="docs-start__card"
            disabled={!ctx.state.hasEditor}
            onClick={() => {
              api.close();
              ctx.actions.exportAs(entry.format);
            }}
          >
            <Share2 size={22} aria-hidden="true" />
            <span className="docs-start__card-title">{entry.label}</span>
            <span className="docs-muted">{entry.detail}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function fileTab(ctx: DocsRibbonContext): RibbonBackstageTab {
  const { state, actions } = ctx;
  const local = state.source === "local";
  return {
    id: "file",
    label: "File",
    mode: "backstage",
    backstage: {
      defaultItem: "new",
      items: [
        { id: "new", label: "New", icon: <FilePlus2 size={16} />, render: (api) => <NewPane ctx={ctx} api={api} /> },
        { id: "open-matrix", label: "Open from Matrix…", icon: <FolderOpen size={16} />, onSelect: () => actions.openFromMatrix() },
        { id: "open-computer", label: "Open from this computer…", icon: <HardDrive size={16} />, onSelect: () => actions.openFromComputer() },
        { id: "save", label: "Save", icon: <Save size={16} />, shortcut: "Ctrl+S", separatorBefore: true, disabled: state.saving, onSelect: () => actions.save() },
        {
          id: "save-copy",
          label: local || !state.hasPath ? "Save a copy to Matrix…" : "Save a copy",
          icon: <SaveAll size={16} />,
          disabled: state.saving,
          onSelect: () => actions.saveCopy(),
        },
        { id: "download", label: "Download a copy", icon: <Download size={16} />, disabled: !state.hasEditor, onSelect: () => actions.downloadCopy() },
        { id: "export", label: "Export", icon: <Share2 size={16} />, render: (api) => <ExportPane ctx={ctx} api={api} /> },
        { id: "close", label: "Close", icon: <X size={16} />, separatorBefore: true, onSelect: () => actions.close() },
      ],
    },
  };
}
