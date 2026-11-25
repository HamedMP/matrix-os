/**
 * The Compare tab of the Docs side panel: pick another version of the open
 * document (from Files, or a file from this device), and the differences
 * open as a new, unsaved document with tracked changes in the markup view.
 * The card answers "Did anything substantive change?" from the engine's
 * classification and lists the changes with jump links.
 */

import { useRef, useState, useSyncExternalStore } from "react";
import type { DragEvent } from "react";
import type { MatrixOSFiles } from "../../../../_shared/matrix-os";
import { Badge, EmptyState, Spinner } from "../../../../_shared/office-ui";
import { compareWithBytes, compareWithFile } from "../../compare/index";
import type { CompareFlowResult } from "../../compare/index";
import type { DocumentEditorController } from "../../editor/index";
import type { DocumentSession } from "../../session/index";
import { CompareSummaryCard } from "./CompareSummaryCard";
import "./compare.css";

export interface ComparePanelProps {
  session: DocumentSession;
  editor: DocumentEditorController | null;
  /** Asks the owner to choose a `.docx` in their home. Resolves null when cancelled. */
  pickDocument?: (options?: { title?: string }) => Promise<string | null>;
  onClose?: () => void;
  readOnly?: boolean;
  review?: unknown;
  /** Default `window.MatrixOS.files`. */
  files?: Pick<MatrixOSFiles, "read">;
}

type PanelState = { status: "idle" } | { status: "working" } | { status: "done"; result: Extract<CompareFlowResult, { status: "compared" }> } | { status: "error"; message: string };

const DOCX = /\.docx$/i;

function bridgeFiles(): Pick<MatrixOSFiles, "read"> | undefined {
  const files = typeof window === "undefined" ? undefined : window.MatrixOS?.files;
  return files !== undefined && typeof files.read === "function" ? files : undefined;
}

export function ComparePanel({ session, editor, pickDocument, files }: ComparePanelProps) {
  const [state, setState] = useState<PanelState>({ status: "idle" });
  // Re-render when a document is opened or closed elsewhere.
  useSyncExternalStore(session.subscribe, session.getState);
  const input = useRef<HTMLInputElement>(null);
  const log = (message: string, error: unknown) => console.warn(message, error);
  const hasDocument = session.document !== null;
  const working = state.status === "working";

  const finish = (result: CompareFlowResult) => {
    if (result.status === "failed") {
      setState({ status: "error", message: result.message });
      return;
    }
    editor?.setViewMode("markup");
    setState({ status: "done", result });
  };

  const run = async (work: () => Promise<CompareFlowResult>) => {
    setState({ status: "working" });
    try {
      finish(await work());
    } catch (error) {
      log("docs compare: the comparison failed", error instanceof Error ? error.name : error);
      setState({ status: "error", message: "The comparison could not be made. Try again." });
    }
  };

  // Each flow takes the open document's key before its first slow step, so a result for a document
  // the owner has since left is dropped instead of replacing the one now open.
  const chooseFromFiles = async () => {
    if (pickDocument === undefined) return;
    const documentKey = session.getState().documentKey;
    const path = await pickDocument({ title: "Compare with another version" });
    if (path === null) return;
    await run(() => compareWithFile({ session, documentKey, files: files ?? bridgeFiles(), log }, path));
  };

  const compareFile = async (file: File | undefined) => {
    if (file === undefined) return;
    if (!DOCX.test(file.name)) {
      setState({ status: "error", message: "Choose a Word document (.docx)." });
      return;
    }
    const documentKey = session.getState().documentKey;
    await run(async () => compareWithBytes({ session, documentKey, log }, new Uint8Array(await file.arrayBuffer()), file.name));
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!working && hasDocument) void compareFile(event.dataTransfer.files[0]);
  };

  if (!hasDocument && state.status !== "done") {
    return <EmptyState headline="Nothing to compare yet" description="Open a document, then compare it with another version." />;
  }

  return (
    <div className="docs-compare" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
      <section className="docs-compare__pick" aria-label="Choose the other version">
        <h3 className="docs-compare__title">Compare with another version</h3>
        <p className="docs-compare__hint">
          The open document is the original. The differences open as a new document with tracked changes; the files stay as they are.
        </p>
        <div className="docs-compare__actions">
          {pickDocument !== undefined && (
            <button type="button" className="oui-button oui-button--primary" disabled={working || !hasDocument} onClick={() => void chooseFromFiles()}>
              Choose from Files…
            </button>
          )}
          <button type="button" className="oui-button" disabled={working || !hasDocument} onClick={() => input.current?.click()}>
            From this device…
          </button>
          <input
            ref={input}
            type="file"
            accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="oui-sr-only"
            aria-label="Word document to compare with"
            tabIndex={-1}
            onChange={(event) => {
              void compareFile(event.target.files?.[0]);
              event.target.value = "";
            }}
          />
        </div>
        <p className="docs-compare__hint">You can also drop a .docx file here.</p>
      </section>
      {working && <Spinner label="Comparing the documents" />}
      {state.status === "error" && (
        <p role="alert" className="docs-compare__error">
          <Badge tone="danger">Could not compare</Badge> {state.message}
        </p>
      )}
      {state.status === "done" && <CompareSummaryCard result={state.result} onJump={(blockId) => editor?.scrollTo(blockId)} />}
    </div>
  );
}

export default ComparePanel;
