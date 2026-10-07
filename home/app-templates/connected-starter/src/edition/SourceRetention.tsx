import Dialog from "./Dialog";
import { useState } from "react";
import type { useEdition } from "./useEdition";
import { sourceStatus } from "./source-status";
export default function SourceRetention({
  data,
}: {
  data: ReturnType<typeof useEdition>;
}) {
  const [selection, setSelection] = useState<{
    sourceId: string;
    email: string;
    mode: "keep" | "purge";
  } | null>(null);
  return (
    <footer className="edition-library-footer">
      <span>✦ More room for the things that matter.</span>
      <details>
        <summary>Sources & retention</summary>
        {data.sources.map((source) => (
          <div key={source.id}>
            <b>
              {source.email} · {source.scope === "work" ? "Work" : "Personal"}
            </b>
            {sourceStatus(source).map((line) => (
              <p key={line}>{line}</p>
            ))}
            <button
              disabled={data.busy || data.offline || source.state === "paused"}
              onClick={() => void data.sync(source.id)}
            >
              Sync this account
            </button>
            <button
              disabled={
                data.busy ||
                data.offline ||
                data.preview ||
                source.state === "paused"
              }
              onClick={() =>
                setSelection({
                  sourceId: source.id,
                  email: source.email,
                  mode: "keep",
                })
              }
            >
              Stop importing
            </button>
            <button
              disabled={data.busy || data.offline || data.preview}
              onClick={() =>
                setSelection({
                  sourceId: source.id,
                  email: source.email,
                  mode: "purge",
                })
              }
            >
              Remove retained account history
            </button>
          </div>
        ))}
        <p>
          Downloaded copies are limited to 50 editions and 5 MB on this device.
          Remote email images are blocked.
        </p>
      </details>
      {selection && (
        <Dialog
          titleId="edition-retention-title"
          onClose={() => setSelection(null)}
        >
          <h2 id="edition-retention-title">
            {selection.mode === "purge"
              ? "Remove retained account history?"
              : "Stop importing this account?"}
          </h2>
          <b>{selection.email}</b>
          <p>
            {selection.mode === "purge"
              ? "Retained history and reading state will be removed from Matrix and from this device. Sharing grants to other apps will be revoked. This cannot be undone. Your source email stays unchanged."
              : "Future imports stop. Retained editions, reading state and authorized sharing remain available. Add this exact account again to resume. Your source email stays unchanged."}
          </p>
          <button
            className="edition-primary"
            disabled={data.busy || data.offline}
            onClick={async () => {
              try {
                if (await data.retention(selection.sourceId, selection.mode))
                  setSelection(null);
              } catch {
                console.warn("Edition account change unavailable");
              }
            }}
          >
            {selection.mode === "purge"
              ? "Remove retained history"
              : "Stop importing account"}
          </button>
          <button disabled={data.busy} onClick={() => setSelection(null)}>
            Keep account
          </button>
        </Dialog>
      )}
    </footer>
  );
}
