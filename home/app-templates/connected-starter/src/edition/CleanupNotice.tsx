import type { useEdition } from "./useEdition";
export default function CleanupNotice({
  data,
}: {
  data: ReturnType<typeof useEdition>;
}) {
  return (
    <>
      {(data.status || data.receipt) && (
        <div className="edition-notice" role="status">
          {data.status || "Previous inbox cleanup is available to review."}
          {data.operations.length > 1 && (
            <select
              aria-label="Inbox cleanup history"
              value={data.receipt?.id ?? ""}
              onChange={(e) => data.selectCleanup(e.target.value)}
            >
              {data.operations.map((op, index) => (
                <option key={op.receipt.id} value={op.receipt.id}>
                  Cleanup {index + 1} · {op.receipt.state.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          )}
          {data.receipt?.state === "needs_verification" && (
            <button
              disabled={data.busy || data.offline}
              onClick={() => void data.cleanupCommit()}
            >
              Verify archive outcome
            </button>
          )}
          {data.receipt &&
            data.receipt.state !== "undone" &&
            (data.receipt.archivedCount ?? 0) > 0 && (
              <button
                disabled={data.busy || data.offline}
                onClick={() => void data.undo()}
              >
                Undo inbox archive
              </button>
            )}
        </div>
      )}
    </>
  );
}
