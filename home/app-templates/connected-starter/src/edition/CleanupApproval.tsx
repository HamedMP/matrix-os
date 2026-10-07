import Dialog from "./Dialog";
import type { useEdition } from "./useEdition";
export default function CleanupApproval({
  data,
}: {
  data: ReturnType<typeof useEdition>;
}) {
  return (
    <>
      {" "}
      {data.approval && (
        <Dialog titleId="edition-cleanup-title" onClose={data.cancelCleanup}>
          <span className="edition-eyebrow">YOUR INBOX, A LITTLE LIGHTER</span>
          <h2 id="edition-cleanup-title">Review inbox cleanup</h2>
          <p>
            These exact saved newsletters will leave your inbox. Their source
            read labels stay unchanged, and their retained editions stay here.
          </p>
          <ul>
            {data.approval.messageIds.map((id) => (
              <li key={id}>
                {data.messages.find((m) => m.id === id)?.subject ??
                  "Saved newsletter"}
                <small>
                  {
                    data.sources.find(
                      (s) =>
                        s.id ===
                        data.messages.find((m) => m.id === id)?.sourceId,
                    )?.email
                  }
                </small>
              </li>
            ))}
          </ul>
          <button
            className="edition-primary"
            disabled={data.busy || data.offline}
            onClick={() => void data.cleanupCommit()}
          >
            Archive {data.approval.messageIds.length} selected{" "}
            {data.approval.messageIds.length === 1
              ? "newsletter"
              : "newsletters"}
          </button>
          <button disabled={data.busy} onClick={data.cancelCleanup}>
            Keep in inbox
          </button>
          <small>
            Nothing is deleted. Confirmed archive changes can be undone.
          </small>
        </Dialog>
      )}
    </>
  );
}
