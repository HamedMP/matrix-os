import React, { useEffect, useRef, useState } from "react";
import {
  storeErrorMessage,
  type StoreClient,
  type StoreListing,
} from "../store-model";
import type { AppStoreInstallJob } from "../generated-store-gateway";
import { ErrorNotice, Metrics, Needs } from "./Shared";
const pendingKey = "matrix-store-pending-install";
function remember(slug: string, id?: string) {
  try {
    if (id)
      sessionStorage.setItem(
        pendingKey,
        JSON.stringify({ slug, id, at: Date.now() }),
      );
    else sessionStorage.removeItem(pendingKey);
  } catch (error) {
    console.warn(
      "Store install recovery storage unavailable",
      error instanceof Error ? error.name : "UnknownError",
    );
  }
}
function resume(slug: string): string | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(pendingKey) ?? "null");
    return value?.slug === slug &&
      typeof value.id === "string" &&
      Date.now() - value.at < 60 * 60 * 1000
      ? value.id
      : null;
  } catch (error) {
    console.warn(
      "Store install recovery unavailable",
      error instanceof Error ? error.name : "UnknownError",
    );
    return null;
  }
}
export default function ListingDetail({
  client,
  slug,
  onBack,
}: {
  client: StoreClient;
  slug: string;
  onBack: () => void;
}) {
  const [detail, setDetail] = useState<StoreListing | null>(null),
    [error, setError] = useState(""),
    [consentedVersion, setConsentedVersion] = useState<string | null>(null),
    [showConsent, setShowConsent] = useState(false);
  const [busy, setBusy] = useState(false),
    [job, setJob] = useState<AppStoreInstallJob | null>(null),
    [refresh, setRefresh] = useState(0),
    [pollAttempt, setPollAttempt] = useState(0);
  const consentKey =
    detail?.currentVersion && detail.capabilitiesDigest
      ? `${detail.slug}:${detail.currentVersion.id}:${detail.capabilitiesDigest}`
      : null;
  const consent = consentKey !== null && consentedVersion === consentKey;
  const setConsent = (value: boolean) =>
    setConsentedVersion(value ? consentKey : null);
  const alive = useRef(true),
    lock = useRef(false),
    title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    setError("");
    void client.detail(slug).then(
      (value) => {
        if (active) setDetail(value);
      },
      (cause) => {
        if (active) setError(storeErrorMessage(cause));
      },
    );
    title.current?.focus();
    return () => {
      active = false;
    };
  }, [client, slug, refresh]);
  const pendingJobId =
    job?.status === "queued" || job?.status === "building" ? job.id : null;
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const restored = resume(slug);
    const jobId = pendingJobId ?? restored;
    if (!jobId) return;
    const started = Date.now();
    let failures = 0;
    const poll = async () => {
      try {
        const result = await client.installJob(jobId);
        if (!active) return;
        failures = 0;
        setError("");
        setJob(result);
        if (result.status === "installed") {
          remember(slug);
          setRefresh((value) => value + 1);
        } else if (result.status === "failed") {
          remember(slug);
          setError(
            storeErrorMessage({ error: result.error ?? "build_failed" }),
          );
        } else if (Date.now() - started < 20 * 60 * 1000)
          timer = setTimeout(() => void poll(), 1500);
        else
          setError(
            "The build is taking longer than expected. Reopen this listing to check its progress.",
          );
      } catch (cause) {
        if (!active) return;
        setError(storeErrorMessage(cause));
        if (++failures <= 3 && Date.now() - started < 20 * 60 * 1000)
          timer = setTimeout(
            () => void poll(),
            Math.min(1500 * 2 ** failures, 10000),
          );
      }
    };
    timer = setTimeout(() => void poll(), pendingJobId ? 1500 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, slug, pendingJobId, pollAttempt]);
  const perform = async (operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await operation();
    } catch (cause) {
      if (alive.current) setError(storeErrorMessage(cause));
    } finally {
      lock.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const install = () =>
    perform(async () => {
      if (!detail?.currentVersion || !detail.capabilitiesDigest || !consent)
        return;
      const result = await client.install(
        slug,
        detail.currentVersion.id,
        detail.capabilitiesDigest,
      );
      if (!alive.current) return;
      setShowConsent(false);
      setConsent(false);
      if ("id" in result) {
        setJob(result);
        if (result.status === "queued" || result.status === "building")
          remember(slug, result.id);
        if (result.status === "failed")
          setError(
            storeErrorMessage({ error: result.error ?? "build_failed" }),
          );
        if (result.status === "installed") setRefresh((value) => value + 1);
      } else {
        remember(slug);
        setRefresh((value) => value + 1);
      }
    });
  const rate = (stars: number | null) =>
    perform(async () => {
      const result = await client.rate(slug, stars);
      if (alive.current)
        setDetail((current) => (current ? { ...current, ...result } : current));
    });
  const building = job?.status === "queued" || job?.status === "building";
  return (
    <section className="store-section">
      <button className="store-back" onClick={onBack}>
        ← Back to community
      </button>
      <ErrorNotice error={error} />
      {error && building && (
        <button
          disabled={busy}
          onClick={() => {
            setError("");
            setPollAttempt((value) => value + 1);
          }}
        >
          Retry build status
        </button>
      )}
      {!detail ? (
        <>
          <p role="status">
            {error ? "App details unavailable." : "Loading app…"}
          </p>
          {error && (
            <button onClick={() => setRefresh((value) => value + 1)}>
              Retry details
            </button>
          )}
        </>
      ) : (
        <>
          <header className="store-detail-heading">
            <div>
              <h2 tabIndex={-1} ref={title}>
                {detail.name}
              </h2>
              <p>{detail.tagline}</p>
              <small>By {detail.publisher.handle}</small>
            </div>
            <div className="store-actions">
              {detail.local.installed && detail.local.launchPath && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform(() =>
                      client.open(detail.name, detail.local.launchPath!),
                    )
                  }
                >
                  Open app
                </button>
              )}
              {detail.status === "live" &&
                (!detail.local.installed || detail.local.updateAvailable) && (
                  <button
                    disabled={
                      busy ||
                      building ||
                      !detail.currentVersion ||
                      !detail.capabilitiesDigest
                    }
                    onClick={() => {
                      setShowConsent(true);
                      setConsent(false);
                    }}
                  >
                    {detail.local.installed ? "Update app" : "Get app"}
                  </button>
                )}
            </div>
          </header>
          <Metrics value={detail} />
          <p>{detail.description}</p>
          {detail.notice === "removed" && (
            <p role="status">
              Removed from the store. Your installed copy is kept; updates are
              unavailable.
            </p>
          )}
          {building && (
            <p role="status">
              {job.status === "queued"
                ? "Queued for a local build…"
                : "Building on your Matrix computer…"}{" "}
              You can leave and check back.
            </p>
          )}
          {job?.status === "installed" && (
            <p role="status">Your app is ready to open.</p>
          )}
          {showConsent && (
            <section
              className="store-consent"
              aria-label="Installation consent"
            >
              <h3>
                {detail.local.installed
                  ? "Update this app"
                  : "Install this app"}
              </h3>
              <Needs capabilities={detail.capabilities} />
              <p>
                The approved full source will be built on your Matrix computer
                in an isolated environment. Your existing app and data are kept
                if the build fails.
              </p>
              <label className="store-check">
                <input
                  type="checkbox"
                  checked={consent}
                  onChange={(event) => setConsent(event.target.checked)}
                />
                I agree to these capabilities for this source version.
              </label>
              <div className="store-actions">
                <button
                  disabled={!consent || busy}
                  onClick={() => void install()}
                >
                  Install source
                </button>
                <button disabled={busy} onClick={() => setShowConsent(false)}>
                  Cancel
                </button>
              </div>
            </section>
          )}
          {!showConsent && <Needs capabilities={detail.capabilities} />}
          <section>
            <h3>
              Version{" "}
              {detail.currentVersion?.version ??
                detail.version ??
                "Unavailable"}
            </h3>
            <p>{detail.currentVersion?.changelog}</p>
            <p>License: {detail.currentVersion?.license ?? "Unavailable"}</p>
            <p>Source is included so you can inspect and adapt your copy.</p>
          </section>
          <section aria-label="Rate this app">
            <h3>Your rating</h3>
            {detail.isPublisher ? (
              <p>Publishers cannot rate their own app.</p>
            ) : detail.local.installed || detail.myInstall ? (
              <>
                <div
                  className="store-stars"
                  role="group"
                  aria-label="Choose stars"
                >
                  {[1, 2, 3, 4, 5].map((stars) => (
                    <button
                      key={stars}
                      aria-label={`Rate ${stars} ${stars === 1 ? "star" : "stars"}`}
                      aria-pressed={detail.myRating === stars}
                      disabled={busy}
                      onClick={() => void rate(stars)}
                    >
                      {stars} ★
                    </button>
                  ))}
                </div>
                {detail.myRating && (
                  <button disabled={busy} onClick={() => void rate(null)}>
                    Remove rating
                  </button>
                )}
              </>
            ) : (
              <p>Install this app before rating it.</p>
            )}
          </section>
        </>
      )}
    </section>
  );
}
