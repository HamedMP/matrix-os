import React, { useEffect, useState } from "react";
import {
  APP_STORE_CATEGORIES,
  storeErrorMessage,
  type StoreClient,
} from "../store-model";
import type { AppStoreGatewayListingSummary } from "../generated-store-gateway";
import ListingDetail from "./ListingDetail";
import { ErrorNotice, Metrics } from "./Shared";
export default function Community({ client }: { client: StoreClient }) {
  const [items, setItems] = useState<AppStoreGatewayListingSummary[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [q, setQ] = useState(""),
    [category, setCategory] = useState(""),
    [sort, setSort] = useState<"popular" | "rating" | "new">("popular");
  const [filter, setFilter] = useState({ q: "", category: "", sort }),
    [selected, setSelected] = useState<string | null>(null),
    [cursor, setCursor] = useState<string | undefined>(),
    [pageCursor, setPageCursor] = useState<string | undefined>();
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    void client
      .catalog({
        ...(filter.q.trim() ? { q: filter.q.trim() } : {}),
        ...(filter.category
          ? {
              category:
                filter.category as (typeof APP_STORE_CATEGORIES)[number],
            }
          : {}),
        sort: filter.sort,
        cursor: pageCursor,
      })
      .then(
        (page) => {
          if (!active) return;
          setItems((current) =>
            pageCursor
              ? [...current, ...page.listings].slice(-500)
              : page.listings,
          );
          setCursor(page.nextCursor);
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
  }, [client, filter, pageCursor, refresh]);
  if (selected)
    return (
      <ListingDetail
        client={client}
        slug={selected}
        onBack={() => {
          setSelected(null);
          setPageCursor(undefined);
          setRefresh((value) => value + 1);
        }}
      />
    );
  return (
    <section className="store-section" aria-labelledby="community-heading">
      <h2 id="community-heading">Made by the community</h2>
      <p>Full source. Yours to install, understand and adapt.</p>
      <form
        role="search"
        className="store-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setPageCursor(undefined);
          setFilter({ q, category, sort });
        }}
      >
        <label>
          Search
          <input
            aria-label="Search community apps"
            value={q}
            maxLength={80}
            onChange={(event) => setQ(event.target.value)}
            placeholder="Find an app"
          />
        </label>
        <label>
          Category
          <select
            aria-label="Community category"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="">All categories</option>
            {APP_STORE_CATEGORIES.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </label>
        <label>
          Sort
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as typeof sort)}
          >
            <option value="popular">Popular</option>
            <option value="rating">Top rated</option>
            <option value="new">Newest</option>
          </select>
        </label>
        <button type="submit">Search</button>
      </form>
      <ErrorNotice error={error} />
      {error && (
        <button onClick={() => setRefresh((value) => value + 1)}>
          Retry catalog
        </button>
      )}
      {loading && <p role="status">Loading community apps…</p>}
      {!loading && !error && !items.length && (
        <p>No apps found. Try another search.</p>
      )}
      <div className="store-grid">
        {items.map((item) => (
          <article className="store-card" key={item.id}>
            <div className="store-app-icon" aria-hidden="true">
              {item.name.slice(0, 1)}
            </div>
            <h3>
              <button onClick={() => setSelected(item.slug)}>
                {item.name}
              </button>
            </h3>
            <p>{item.tagline}</p>
            <small>By {item.publisher.handle}</small>
            <Metrics value={item} />
            <p className="store-integrations">
              {item.integrations.length
                ? `Works with ${item.integrations.map((value) => value.service).join(", ")}`
                : "No integrations required"}
            </p>
            {item.local.installed && (
              <small>
                {item.local.updateAvailable ? "Update available" : "Installed"}
              </small>
            )}
          </article>
        ))}
      </div>
      {cursor && (
        <button disabled={loading} onClick={() => setPageCursor(cursor)}>
          Load more apps
        </button>
      )}
    </section>
  );
}
