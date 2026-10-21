import React, { useEffect, useRef, useState } from "react";
import { storeErrorMessage, type StoreClient } from "../store-model";
import type { AppStoreReviewQueueItem } from "../generated-store";
import ReviewDetail from "./ReviewDetail";
import { ErrorNotice } from "./Shared";
export default function Review({ client }: { client: StoreClient }) {
  const [items, setItems] = useState<AppStoreReviewQueueItem[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"in_review" | "changes_requested">(
      "in_review",
    ),
    [selected, setSelected] = useState<string | null>(null),
    [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<string | undefined>(),
    [page, setPage] = useState<string | undefined>();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void client
      .queue(status, page)
      .then(
        (result) => {
          if (active) {
            setItems((current) =>
              page ? [...current, ...result.items].slice(-500) : result.items,
            );
            setCursor(result.nextCursor);
          }
        },
        (cause) => {
          if (active) setError(storeErrorMessage(cause));
        },
      )
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, status, page, refresh]);
  if (selected)
    return (
      <ReviewDetail
        key={selected}
        client={client}
        id={selected}
        onBack={() => {
          setSelected(null);
          setPage(undefined);
          setRefresh((value) => value + 1);
          requestAnimationFrame(() => heading.current?.focus());
        }}
      />
    );
  return (
    <section className="store-section">
      <h2 tabIndex={-1} ref={heading}>
        Review submissions
      </h2>
      <p>
        Inspect the complete source and declared access before deciding. Scanner
        and AI notes are advisory.
      </p>
      <div className="store-filters">
        <label>
          Queue status
          <select
            value={status}
            onChange={(event) => {
              setPage(undefined);
              setStatus(event.target.value as typeof status);
            }}
          >
            <option value="in_review">Awaiting review</option>
            <option value="changes_requested">Changes requested</option>
          </select>
        </label>
        <button
          onClick={() => {
            setPage(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh queue
        </button>
      </div>
      <ErrorNotice error={error} />
      {loading && <p role="status">Loading review queue…</p>}
      {!loading && !items.length && !error && (
        <p>No submissions in this queue.</p>
      )}
      <ul className="store-list">
        {items.map((item) => (
          <li key={item.versionId}>
            <button onClick={() => setSelected(item.versionId)}>
              {item.name} · {item.version}
            </button>
            <p>
              By {item.publisherHandle} ·{" "}
              {item.isUpdate ? "Update" : "New listing"} ·{" "}
              {item.status.replaceAll("_", " ")}
            </p>
            <p>
              {item.scan.high} high · {item.scan.medium} medium ·{" "}
              {item.scan.low} low findings · {item.integrationCount}{" "}
              integrations
            </p>
          </li>
        ))}
      </ul>
      {cursor && (
        <button disabled={loading} onClick={() => setPage(cursor)}>
          Load more reviews
        </button>
      )}
    </section>
  );
}
