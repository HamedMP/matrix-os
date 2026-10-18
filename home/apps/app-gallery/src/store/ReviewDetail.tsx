import React, { useEffect, useRef, useState } from "react";
import {
  storeErrorMessage,
  type StoreClient,
  type StoreDecision,
  type StoreListingAction,
  type StoreReview,
} from "../store-model";
import { ErrorNotice, Needs } from "./Shared";
import ReviewFiles from "./ReviewFiles";
type Decision = StoreDecision["type"] | StoreListingAction["type"];
export default function ReviewDetail({
  client,
  id,
  onBack,
}: {
  client: StoreClient;
  id: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<StoreReview | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [decision, setDecision] = useState<Decision | null>(null),
    [message, setMessage] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    lock = useRef(false),
    messageInput = useRef<HTMLTextAreaElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    void client.review(id).then(
      (value) => {
        if (active) setDetail(value);
      },
      (cause) => {
        if (active) setError(storeErrorMessage(cause));
      },
    );
    heading.current?.focus();
    return () => {
      active = false;
    };
  }, [client, id, refresh]);
  useEffect(() => {
    if (decision) messageInput.current?.focus();
  }, [decision]);
  const confirm = async () => {
    if (
      !detail ||
      !decision ||
      lock.current ||
      (decision !== "approve" && !message.trim())
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (
        decision === "delist" ||
        decision === "suspend" ||
        decision === "reinstate"
      )
        await client.listingAction(detail.listing.id, {
          type: decision,
          message: message.trim(),
        });
      else
        await client.decide(
          id,
          decision === "approve"
            ? {
                type: "approve",
                ...(message.trim() ? { message: message.trim() } : {}),
              }
            : { type: decision, message: message.trim() },
        );
      if (alive.current) {
        setNotice(
          decision === "approve"
            ? "Approved source is published. Installers build it on their own computers."
            : "Decision recorded.",
        );
        setDecision(null);
        setMessage("");
        setRefresh((value) => value + 1);
      }
    } catch (cause) {
      if (alive.current) {
        setError(storeErrorMessage(cause));
        setRefresh((value) => value + 1);
      }
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const choose = (value: Decision) => {
    setDecision(value);
    setMessage("");
  };
  return (
    <section className="store-section">
      <button onClick={onBack}>← Back to review queue</button>
      <ErrorNotice error={error} />
      {error && (
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            setRefresh((value) => value + 1);
          }}
        >
          Refresh submission
        </button>
      )}
      {!detail ? (
        <p role="status">Loading submission…</p>
      ) : (
        <>
          <header>
            <h2 tabIndex={-1} ref={heading}>
              {detail.item.name} · {detail.item.version}
            </h2>
            <p>
              By {detail.item.publisherHandle} ·{" "}
              {detail.item.status.replaceAll("_", " ")}
            </p>
          </header>
          <section>
            <h3>Proposed listing</h3>
            <p>{detail.proposed.tagline}</p>
            <p>{detail.proposed.description}</p>
            <p>
              {detail.proposed.category} · {detail.proposed.license}
            </p>
            <p>{detail.proposed.changelog}</p>
            <p>
              Previous published version:{" "}
              {detail.listing.currentVersion ?? "None"}
            </p>
            <p>Listing: {detail.listing.status}</p>
          </section>
          <Needs capabilities={detail.capabilities} />
          {detail.previousCapabilities && (
            <details>
              <summary>Previous version capabilities</summary>
              <Needs capabilities={detail.previousCapabilities} />
            </details>
          )}
          <section>
            <h3>Scan findings</h3>
            {detail.scanReport?.findings.length ? (
              <ul>
                {detail.scanReport.findings.map((item, index) => (
                  <li key={`${item.file}:${index}`}>
                    <strong>
                      {item.severity} · {item.category}
                    </strong>{" "}
                    · {item.file}
                    {item.line ? `:${item.line}` : ""} — {item.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p>
                No findings reported. This does not prove the source is safe.
              </p>
            )}
            {detail.scanReport?.truncated && <p>Findings truncated.</p>}
          </section>
          <section>
            <h3>Generalization report</h3>
            <p>AI: {detail.generalizationReport.ai}</p>
            <ul>
              {detail.generalizationReport.changes.map((item, index) => (
                <li key={`${item.file}:${index}`}>
                  {item.category} · {item.file} — {item.summary}
                </li>
              ))}
            </ul>
            {detail.generalizationReport.notes && (
              <p>{detail.generalizationReport.notes}</p>
            )}
          </section>
          <ReviewFiles client={client} detail={detail} />
          <section>
            <h3>Moderation history</h3>
            <ul>
              {detail.events.map((item, index) => (
                <li key={`${item.createdAt}:${index}`}>
                  {item.action.replaceAll("_", " ")} · {item.actorKind} ·{" "}
                  <time>{item.createdAt}</time>
                  {item.message && <p>{item.message}</p>}
                </li>
              ))}
            </ul>
          </section>
          {detail.item.status === "in_review" && (
            <div className="store-actions">
              <button
                disabled={busy || detail.item.scan.blocking}
                onClick={() => choose("approve")}
              >
                Approve source
              </button>
              <button disabled={busy} onClick={() => choose("request_changes")}>
                Request changes
              </button>
              <button disabled={busy} onClick={() => choose("reject")}>
                Reject
              </button>
            </div>
          )}
          <div className="store-actions">
            <button
              disabled={busy || detail.listing.status === "pending"}
              onClick={() => choose("delist")}
            >
              Delist
            </button>
            <button
              disabled={busy || detail.listing.status === "pending"}
              onClick={() => choose("suspend")}
            >
              Suspend
            </button>
            <button
              disabled={
                busy ||
                !["suspended", "delisted"].includes(detail.listing.status)
              }
              onClick={() => choose("reinstate")}
            >
              Reinstate
            </button>
          </div>
          {decision && (
            <section className="store-consent" aria-label="Review decision">
              <h3>{decision.replaceAll("_", " ")}</h3>
              {decision === "approve" && (
                <p>
                  This publishes the reviewed full source immediately with
                  signed approval. Each installer builds its own copy.
                </p>
              )}
              <label>
                Reviewer message
                <textarea
                  ref={messageInput}
                  aria-label="Reviewer message"
                  value={message}
                  maxLength={2000}
                  required={decision !== "approve"}
                  onChange={(event) => setMessage(event.target.value)}
                />
              </label>
              <div className="store-actions">
                <button
                  disabled={busy || (decision !== "approve" && !message.trim())}
                  onClick={() => void confirm()}
                >
                  Confirm decision
                </button>
                <button disabled={busy} onClick={() => setDecision(null)}>
                  Cancel decision
                </button>
              </div>
            </section>
          )}
          {notice && <p role="status">{notice}</p>}
        </>
      )}
    </section>
  );
}
