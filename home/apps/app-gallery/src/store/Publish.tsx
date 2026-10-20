import React, { useEffect, useRef, useState } from "react";
import {
  storeErrorMessage,
  type StoreClient,
  type StoreStatus,
} from "../store-model";
import type {
  AppStoreDraftSummary,
  AppStorePublishableApp,
} from "../generated-store-gateway";
import DraftDetail from "./DraftDetail";
import { ErrorNotice } from "./Shared";
export default function Publish({
  client,
  status,
}: {
  client: StoreClient;
  status: StoreStatus;
}) {
  const [apps, setApps] = useState<AppStorePublishableApp[]>([]),
    [drafts, setDrafts] = useState<AppStoreDraftSummary[]>([]),
    [selected, setSelected] = useState<string | null>(null);
  const [app, setApp] = useState(""),
    [consentedSource, setConsentedSource] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const alive = useRef(true),
    lock = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const aiConsent =
    !!status.generalizer?.accessSourceId &&
    consentedSource === status.generalizer.accessSourceId;
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.all([client.publishable(), client.drafts()]).then(
      ([available, saved]) => {
        if (active) {
          setApps(available.apps);
          setDrafts(saved.drafts);
        }
      },
      (cause) => {
        if (active) setError(storeErrorMessage(cause));
      },
    );
    return () => {
      active = false;
    };
  }, [client, refresh]);
  const accessSourceId =
    status.generalizer?.available && aiConsent
      ? status.generalizer.accessSourceId
      : undefined;
  const create = async () => {
    if (lock.current || !app || (status.generalizer?.available && !aiConsent))
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await client.createDraft(app, accessSourceId);
      if (alive.current) setSelected(result.id);
    } catch (cause) {
      if (alive.current) setError(storeErrorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <section className="store-section" aria-labelledby="publish-title">
      <h2 id="publish-title">Share something you made</h2>
      <p>
        Prepare a separate copy, remove personal details and review every
        change. Your original app stays yours.
      </p>
      <aside className="store-disclosure">
        <h3>Before AI preparation</h3>
        {status.generalizer?.available ? (
          <>
            <p>
              Scrubbed source will be sent to {status.generalizer.label}.
              Scanning can miss sensitive information. Review what you share and
              only use code you have rights to publish.
            </p>
            <label className="store-check">
              <input
                type="checkbox"
                checked={aiConsent}
                onChange={(event) =>
                  setConsentedSource(
                    event.target.checked
                      ? status.generalizer!.accessSourceId
                      : null,
                  )
                }
              />
              I agree to send scrubbed source to {status.generalizer.label} for
              preparation.
            </label>
          </>
        ) : (
          <p>
            AI preparation is unavailable. You can prepare a copy for
            deterministic checks and inspect anything that needs manual
            attention.
          </p>
        )}
        <p>
          No source is uploaded to the Matrix store until you review the result
          and separately consent to submit it.
        </p>
      </aside>
      {selected ? (
        <DraftDetail
          key={selected}
          client={client}
          id={selected}
          accessSourceId={accessSourceId}
          onBack={() => {
            setSelected(null);
            setRefresh((value) => value + 1);
          }}
        />
      ) : (
        <>
          <ErrorNotice error={error} />
          {error && (
            <button onClick={() => setRefresh((value) => value + 1)}>
              Retry publishing
            </button>
          )}
          <div className="store-publish-picker">
            <label>
              App to publish
              <select
                aria-label="App to publish"
                value={app}
                onChange={(event) => setApp(event.target.value)}
              >
                <option value="">Choose an app</option>
                {apps.map((item) => (
                  <option
                    key={item.slug}
                    value={item.slug}
                    disabled={!item.eligible}
                  >
                    {item.name}
                    {item.eligible
                      ? ""
                      : ` (${item.reason?.replaceAll("_", " ") ?? "unavailable"})`}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={
                busy || !app || (!!status.generalizer?.available && !aiConsent)
              }
              onClick={() => void create()}
            >
              Prepare shareable copy
            </button>
          </div>
          <h3>Your private drafts</h3>
          {drafts.length ? (
            <ul className="store-list">
              {drafts.map((item) => (
                <li key={item.id}>
                  <button onClick={() => setSelected(item.id)}>
                    {item.sourceName} · {item.status.replaceAll("_", " ")}
                  </button>
                  <small>
                    {item.blockingFindings} blocking findings · expires{" "}
                    {new Date(item.expiresAt).toLocaleDateString()}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            <p>No saved drafts.</p>
          )}
        </>
      )}
    </section>
  );
}
