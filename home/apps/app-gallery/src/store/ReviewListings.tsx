import React, { useEffect, useRef, useState } from "react";
import {
  storeErrorMessage,
  type StoreClient,
  type StoreListingAction,
} from "../store-model";
import type { AppStoreListingSummary } from "../generated-store";
import { ErrorNotice, Metrics } from "./Shared";
type Action = StoreListingAction["type"];
export default function ReviewListings({
  client,
  onBack,
}: {
  client: StoreClient;
  onBack: () => void;
}) {
  const [items, setItems] = useState<AppStoreListingSummary[]>([]);
  const [search, setSearch] = useState(""),
    [query, setQuery] = useState("");
  const [page, setPage] = useState<string | undefined>(),
    [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false);
  const [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const [decision, setDecision] = useState<{
    listing: AppStoreListingSummary;
    type: Action;
  } | null>(null);
  const [message, setMessage] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    locked = useRef(false),
    messageInput = useRef<HTMLTextAreaElement>(null);
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
      .reviewListings({ q: query || undefined, sort: "new", cursor: page })
      .then(
        (result) => {
          if (active) {
            setItems((current) =>
              page
                ? [...current, ...result.listings].slice(-500)
                : result.listings,
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
  }, [client, page, query, refresh]);
  useEffect(() => {
    if (decision) messageInput.current?.focus();
  }, [decision]);
  const choose = (listing: AppStoreListingSummary, type: Action) => {
    setDecision({ listing, type });
    setMessage("");
    setNotice("");
  };
  const confirm = async () => {
    if (!decision || !message.trim() || locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await client.listingAction(decision.listing.id, {
        type: decision.type,
        message: message.trim(),
      });
      if (alive.current) {
        setItems((current) =>
          current.map((item) => (item.id === result.id ? result : item)),
        );
        setDecision(null);
        setMessage("");
        setNotice("Listing moderation recorded.");
      }
    } catch (cause) {
      if (alive.current) setError(storeErrorMessage(cause));
    } finally {
      locked.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="store-section">
      <button disabled={busy} onClick={onBack}>
        Back to review queue
      </button>
      <h2>Published listings</h2>
      <p>Manage published apps, including delisted and suspended listings.</p>
      <form
        className="store-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPage(undefined);
          setQuery(search.trim());
          setRefresh((value) => value + 1);
        }}
      >
        <label>
          Search published listings
          <input
            value={search}
            maxLength={80}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button type="submit" disabled={busy}>Search listings</button>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => {
            setPage(undefined);
            setRefresh((value) => value + 1);
          }}
        >
          Refresh listings
        </button>
      </form>
      <ErrorNotice error={error} />
      {notice && <p role="status">{notice}</p>}
      {loading && <p role="status">Loading published listings…</p>}
      {!loading && !items.length && !error && (
        <p>No published listings found.</p>
      )}
      {decision && (
        <section className="store-consent" aria-label="Listing moderation">
          <h3>
            {decision.type} {decision.listing.name}
          </h3>
          <label>
            Moderation message
            <textarea
              ref={messageInput}
              value={message}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setMessage(event.target.value)}
            />
          </label>
          <div className="store-actions">
            <button
              disabled={busy || !message.trim()}
              onClick={() => void confirm()}
            >
              Confirm {decision.type}
            </button>
            <button disabled={busy} onClick={() => setDecision(null)}>
              Cancel moderation
            </button>
          </div>
        </section>
      )}
      <div className="store-grid">
        {items.map((item) => (
          <article className="store-card" key={item.id}>
            <h3>{item.name}</h3>
            <p>
              By {item.publisher.handle} · {item.status} · {item.version}
            </p>
            <Metrics value={item} />
            <div className="store-actions">
              {item.status !== "delisted" && (
                <button
                  disabled={busy || loading}
                  aria-label={`Delist ${item.name}`}
                  onClick={() => choose(item, "delist")}
                >
                  Delist
                </button>
              )}
              {item.status !== "suspended" && (
                <button
                  disabled={busy || loading}
                  aria-label={`Suspend ${item.name}`}
                  onClick={() => choose(item, "suspend")}
                >
                  Suspend
                </button>
              )}
              {["delisted", "suspended"].includes(item.status) && (
                <button
                  disabled={busy || loading}
                  aria-label={`Reinstate ${item.name}`}
                  onClick={() => choose(item, "reinstate")}
                >
                  Reinstate
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {cursor && (
        <button disabled={loading || busy} onClick={() => setPage(cursor)}>
          Load more published listings
        </button>
      )}
    </section>
  );
}
