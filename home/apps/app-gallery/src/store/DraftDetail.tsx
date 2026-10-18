import React, { useEffect, useRef, useState } from "react";
import {
  APP_STORE_LICENSES,
  storeErrorMessage,
  type StoreClient,
  type StoreDraft,
} from "../store-model";
import type { AppStoreDraftDiff } from "../generated-store-gateway";
import { ErrorNotice, Needs } from "./Shared";
import ListingEditor from "./ListingEditor";
import DraftChanges from "./DraftChanges";
export default function DraftDetail({
  client,
  id,
  accessSourceId,
  onBack,
}: {
  client: StoreClient;
  id: string;
  accessSourceId?: string;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<StoreDraft | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [instructions, setInstructions] = useState(""),
    [diff, setDiff] = useState<AppStoreDraftDiff | null>(null),
    [license, setLicense] = useState(""),
    [consent, setConsent] = useState(false);
  const [dirty, setDirty] = useState(false),
    [notice, setNotice] = useState("");
  const alive = useRef(true),
    lock = useRef(false),
    fileRequest = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      fileRequest.current++;
    };
  }, []);
  useEffect(() => {
    let active = true;
    let pending = false;
    const started = Date.now();
    setError("");
    const load = async () => {
      if (!active || pending) return;
      pending = true;
      try {
        const value = await client.draft(id);
        if (!active) return;
        setDraft(value);
        if (
          !["preparing", "submitting"].includes(value.status) ||
          Date.now() - started >= 20 * 60 * 1000
        )
          clearInterval(timer);
      } catch (cause) {
        clearInterval(timer);
        if (active) setError(storeErrorMessage(cause));
      } finally {
        pending = false;
      }
    };
    const timer = setInterval(() => void load(), 1500);
    void load();
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [client, id, refresh]);
  const perform = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (alive.current) setError(storeErrorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const file = async (path: string) => {
    const request = ++fileRequest.current;
    setError("");
    try {
      const value = await client.diff(id, path);
      if (alive.current && request === fileRequest.current) setDiff(value);
    } catch (cause) {
      if (alive.current && request === fileRequest.current)
        setError(storeErrorMessage(cause));
    }
  };
  const processing =
    draft?.status === "preparing" || draft?.status === "submitting";
  return (
    <section className="store-draft">
      <button onClick={onBack}>← Back to drafts</button>
      <ErrorNotice error={error} />
      {error && (
        <button onClick={() => setRefresh((value) => value + 1)}>
          Refresh draft
        </button>
      )}
      {!draft ? (
        <p role="status">Loading draft…</p>
      ) : (
        <>
          <h3>{draft.sourceName}</h3>
          <p role="status">
            {draft.status.replaceAll("_", " ")} · {draft.stage}
            {processing && "…"}
          </p>
          {draft.failureCode && (
            <p className="store-error">
              Preparation needs attention (
              {draft.failureCode.replaceAll("_", " ")}). Your original app is
              kept.
            </p>
          )}
          {draft.ai !== "completed" && (
            <p>
              AI preparation {draft.ai ?? "has not completed"}. Review all
              source before sharing.
            </p>
          )}
          <DraftChanges draft={draft} diff={diff} onFile={file} />
          <Needs capabilities={draft.capabilities} />
          {draft.listing && (
            <ListingEditor
              key={`${draft.id}:${refresh}`}
              listing={draft.listing}
              disabled={busy || processing || draft.status === "submitted"}
              onDirty={() => {
                setDirty(true);
                setConsent(false);
              }}
              onSave={(value) =>
                perform(async () => {
                  const result = await client.saveListing(id, value);
                  if (alive.current) {
                    setDraft(result);
                    setDirty(false);
                    setConsent(false);
                    setNotice("Listing saved. Review it before submitting.");
                  }
                })
              }
            />
          )}
          {draft.status !== "submitted" && (
            <>
              <form
                className="store-revise"
                onSubmit={(event) => {
                  event.preventDefault();
                  void perform(async () => {
                    await client.revise(id, instructions, accessSourceId);
                    if (alive.current) {
                      setInstructions("");
                      setConsent(false);
                      setDirty(false);
                      setRefresh((value) => value + 1);
                    }
                  });
                }}
              >
                <label>
                  Ask for a revision
                  <textarea
                    value={instructions}
                    maxLength={1000}
                    onChange={(event) => setInstructions(event.target.value)}
                  />
                </label>
                <button
                  type="submit"
                  disabled={
                    busy ||
                    processing ||
                    !instructions.trim() ||
                    !accessSourceId
                  }
                >
                  Revise copy
                </button>
                {!accessSourceId && (
                  <p>
                    Consent to your selected AI provider above before requesting
                    AI changes.
                  </p>
                )}
              </form>
              <section className="store-consent">
                <h4>Submit the reviewed full source</h4>
                <label>
                  License
                  <select
                    aria-label="Publishing license"
                    value={license}
                    onChange={(event) => {
                      setLicense(event.target.value);
                      setConsent(false);
                    }}
                  >
                    <option value="">Choose a license</option>
                    {APP_STORE_LICENSES.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label className="store-check">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(event) => setConsent(event.target.checked)}
                  />
                  I reviewed the changes and listing, have rights to this code,
                  and agree to publish the full generalized source under this
                  license.
                </label>
                <p>
                  People receive the source and build it on their own Matrix
                  computers. Check for sensitive information before submitting.
                </p>
                <button
                  disabled={
                    busy ||
                    draft.status !== "ready" ||
                    !!draft.blockingFindings ||
                    dirty ||
                    !consent ||
                    !license
                  }
                  onClick={() =>
                    void perform(async () => {
                      await client.submit(id, license);
                      if (alive.current) {
                        setConsent(false);
                        setRefresh((value) => value + 1);
                      }
                    })
                  }
                >
                  Submit for review
                </button>
                {dirty && <p>Save your listing changes before submitting.</p>}
              </section>
            </>
          )}
          {draft.submission && (
            <p role="status">
              Submitted as {draft.submission.listingSlug}{" "}
              {draft.submission.version} ·{" "}
              {draft.submission.status.replaceAll("_", " ")}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          {!processing && draft.status !== "submitted" && (
            <button
              disabled={busy}
              onClick={() =>
                void perform(async () => {
                  await client.deleteDraft(id);
                  if (alive.current) onBack();
                })
              }
            >
              Delete private draft
            </button>
          )}
        </>
      )}
    </section>
  );
}
