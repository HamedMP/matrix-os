"use client";
import React, { useEffect, useRef, useState } from "react";
import { readUsageExport } from "@matrix-os/contracts/ai-usage";
import { AiUsagePanel } from "./AiUsagePanel";
export type UsageSnapshot = ReturnType<typeof readUsageExport>;
const refreshEveryMs = 60 * 60 * 1000;
const checkedTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});
/** The caller keys this component by authenticated owner and runtime generation. */
export function AutomaticAiUsagePanel({
  load,
  sourceLabel,
  loadingLabel,
}: {
  load(
    signal: AbortSignal,
    trigger: "open" | "manual" | "hourly",
  ): Promise<UsageSnapshot>;
  sourceLabel: string;
  loadingLabel?: string;
}) {
  const trigger = useRef<"open" | "manual" | "hourly">("open");
  const [snapshot, setSnapshot] = useState<{
      value: UsageSnapshot;
      checkedAt: Date;
    } | null>(null),
    [failure, setFailure] = useState(false),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(false);
    void load(controller.signal, trigger.current)
      .then((value) => {
        controller.signal.throwIfAborted();
        const parsed = readUsageExport(value);
        setSnapshot({ value: parsed, checkedAt: new Date() });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.warn(
            "Automatic usage unavailable",
            error instanceof Error ? error.name : "UnknownError",
          );
          setFailure(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [load, revision]);
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      trigger.current = "hourly";
      setRevision((v) => v + 1);
    }, refreshEveryMs);
    return () => clearTimeout(timer);
  }, [loading, revision]);
  return (
    <div>
      <div className="ai-usage au-auto-status">
        <span className="au-auto-message">
          <span>
            {loading
              ? (loadingLabel ?? `Detecting usage on ${sourceLabel}…`)
              : failure
                ? `Scan unavailable · ${sourceLabel}`
                : `Automatically detected · ${sourceLabel}`}
          </span>
          <small>
            {snapshot && (
              <>
                <time
                  dateTime={snapshot.checkedAt.toISOString()}
                  title={snapshot.checkedAt.toLocaleString()}
                >
                  Last checked {checkedTime.format(snapshot.checkedAt)}
                </time>{" "}
                ·{" "}
              </>
            )}
            Refreshes hourly
          </small>
        </span>
        <button
          type="button"
          disabled={loading}
          onClick={() => {
            trigger.current = "manual";
            setRevision((v) => v + 1);
          }}
        >
          Refresh usage
        </button>
      </div>
      {failure && (
        <p role="alert" className="ai-usage">
          {snapshot
            ? "Could not refresh usage. Showing the last loaded history; retry or wait for the next hourly check."
            : "Automatic usage scan is unavailable. Retry or connect to a computer with the latest Matrix version."}
        </p>
      )}
      {snapshot ? (
        <AiUsagePanel
          key="loaded"
          initialEvents={snapshot.value.events}
          history={snapshot.value.history}
          initialIssues={snapshot.value.issues}
          initialSourceLabel={sourceLabel}
          allowFileSelection={false}
          timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        />
      ) : !loading ? (
        <AiUsagePanel key="empty" allowFileSelection={false} />
      ) : null}
    </div>
  );
}
