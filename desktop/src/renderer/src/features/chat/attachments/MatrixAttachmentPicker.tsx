import { Dialog } from "../../../design/primitives";
import { Folder, HardDrive, Upload, X } from "../../../lib/hugeicons";
import { InspectorFilesPanel, type InspectorFileTarget } from "../../panels/InspectorFilesPanel";
import type { WorkFilesScope } from "../../work/work-files-scope";
import "./matrix-attachment-picker.css";

export function MatrixAttachmentPicker({ project, source, pending, error, close, chooseDevice, changeSource, select }: {
  project?: Extract<WorkFilesScope, { kind: "project" }>;
  source: "project" | "home";
  pending: boolean;
  error: string | null;
  close: () => void;
  chooseDevice: () => void;
  changeSource: (source: "project" | "home") => void;
  select: (target: InspectorFileTarget) => void;
}) {
  return (
    <Dialog open onClose={close} title="Attach files" placement="center" width={576}>
      <div className="matrix-attachment-picker">
        <header className="matrix-attachment-picker-header">
          <p>Attach files</p>
          <button type="button" className="matrix-attachment-picker-close" aria-label="Close attachment picker" onClick={close}>
            <X size={17} aria-hidden />
          </button>
        </header>
        <div className="matrix-attachment-picker-source">
          <div className="matrix-attachment-picker-location">
            <HardDrive size={16} aria-hidden />
            <span>Matrix Files</span>
          </div>
          {project ? (
            <div className="matrix-attachment-picker-sources" role="group" aria-label="File source">
              <button type="button" disabled={pending} aria-pressed={source === "project"} onClick={() => changeSource("project")}>
                Project files
              </button>
              <button type="button" disabled={pending} aria-pressed={source === "home"} onClick={() => changeSource("home")}>
                Matrix home
              </button>
            </div>
          ) : <span className="matrix-attachment-picker-home"><Folder size={14} aria-hidden />Home</span>}
        </div>
        <fieldset className="matrix-attachment-picker-browser" aria-label="Matrix files" aria-busy={pending} disabled={pending}>
          <InspectorFilesPanel
            key={source}
            browserOnly attachmentPicker
            scope={source === "project" && project ? project : { kind: "home", chatId: "attachment-picker" }}
            onOpenFile={select}
          />
        </fieldset>
        {pending || error ? <div className="matrix-attachment-picker-notice">
          {pending ? <p role="status">Reading Matrix file…</p> : null}
          {error ? <p role="alert">{error}</p> : null}
        </div> : null}
        <footer className="matrix-attachment-picker-footer">
          <button type="button" disabled={pending} className="matrix-attachment-picker-device" onClick={chooseDevice}>
            <Upload size={15} aria-hidden />
            Upload from device
          </button>
          <button type="button" className="matrix-attachment-picker-cancel" onClick={close}>Cancel</button>
        </footer>
      </div>
    </Dialog>
  );
}
