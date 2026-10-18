import React, { useEffect, useRef, useState } from "react";
import { storeErrorMessage, type StoreClient } from "../store-model";
import type {
  AppStorePublisherListing,
  AppStoreSubmissionSummary,
} from "../generated-store";
import { ErrorNotice, Metrics } from "./Shared";
const withdrawable = new Set([
  "awaiting_upload",
  "scan_failed",
  "in_review",
  "changes_requested",
]);
export default function Submissions({ client }: { client: StoreClient }) {
  const [items, setItems] = useState<AppStoreSubmissionSummary[]>([]),
    [listings, setListings] = useState<AppStorePublisherListing[]>([]),
    [error, setError] = useState("");
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0),
    [cursor, setCursor] = useState<string | undefined>(),
    [page, setPage] = useState<string | undefined>();
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void client
      .submissions(page)
      .then(
        (result) => {
          if (active) {
            setItems((current) =>
              page
                ? [...current, ...result.submissions].slice(-500)
                : result.submissions,
            );
            setListings(result.listings);
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
  }, [client, refresh, page]);
  const withdraw = async (id: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await client.withdraw(id);
      if (alive.current)
        setItems((current) =>
          current.map((item) => (item.versionId === id ? result : item)),
        );
    } catch (cause) {
      if (alive.current) setError(storeErrorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="store-section">
      <h2>My submissions</h2>
      <p>Your published apps and versions awaiting staff review.</p>
      <button
        onClick={() => {
          setPage(undefined);
          setRefresh((value) => value + 1);
        }}
        disabled={loading || busy}
      >
        Refresh submissions
      </button>
      <ErrorNotice error={error} />
      {loading && <p role="status">Loading submissions…</p>}
      <div className="store-grid">
        {listings.map((item) => (
          <article className="store-card" key={item.id}>
            <h3>{item.name}</h3>
            <p>
              {item.status} · {item.currentVersion ?? "No published version"}
            </p>
            <Metrics value={item} />
          </article>
        ))}
      </div>
      <ul className="store-list">
        {items.map((item) => (
          <li key={item.versionId}>
            <h3>
              {item.name} <small>{item.version}</small>
            </h3>
            <p>{item.status.replaceAll("_", " ")}</p>
            {item.reviewerMessage && <p>Reviewer: {item.reviewerMessage}</p>}
            {item.scan && (
              <p>
                {item.scan.findingCount} findings
                {item.scan.blocking ? " · needs attention" : ""}
              </p>
            )}
            {withdrawable.has(item.status) && (
              <button
                disabled={busy}
                onClick={() => void withdraw(item.versionId)}
              >
                Withdraw {item.name} {item.version}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!loading && !items.length && !error && (
        <p>No submissions yet. Prepare a copy in Publish to get started.</p>
      )}
      {cursor && (
        <button disabled={loading || busy} onClick={() => setPage(cursor)}>
          Load more submissions
        </button>
      )}
    </section>
  );
}
