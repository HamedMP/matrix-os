"use client";
import React, { useEffect, useState } from "react";
import { readUsageExport } from "@matrix-os/contracts/ai-usage";
import { AiUsagePanel } from "./AiUsagePanel";
export type UsageSnapshot = ReturnType<typeof readUsageExport>;
/** The caller keys this component by authenticated owner and runtime generation. */
export function AutomaticAiUsagePanel({
  load,
  sourceLabel,
}: {
  load(signal: AbortSignal): Promise<UsageSnapshot>;
  sourceLabel: string;
}) {
  const [snapshot, setSnapshot] = useState<{
      value: UsageSnapshot;
      receipt: number;
    } | null>(null),
    [failure, setFailure] = useState(false),
    [revision, setRevision] = useState(0),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailure(false);
    void load(controller.signal)
      .then((value) => {
        controller.signal.throwIfAborted();
        const parsed = readUsageExport(value);
        setSnapshot((previous) => ({
          value: parsed,
          receipt: (previous?.receipt ?? 0) + 1,
        }));
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
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [load, revision]);
  return (
    <div>
      <div className="ai-usage au-auto-status">
        <span>
          {loading
            ? `Detecting usage on ${sourceLabel}…`
            : failure
              ? `Scan unavailable · ${sourceLabel}`
              : `Automatically detected · ${sourceLabel}`}
        </span>
        <button
          type="button"
          disabled={loading}
          onClick={() => setRevision((v) => v + 1)}
        >
          Refresh usage
        </button>
      </div>
      {failure && (
        <p role="alert" className="ai-usage">
          Automatic usage scan is unavailable. Retry or connect to a computer
          with the latest Matrix version.
        </p>
      )}
      {snapshot ? (
        <AiUsagePanel
          key={snapshot.receipt}
          initialEvents={snapshot.value.events}
          initialIssues={snapshot.value.issues}
          initialSourceLabel={sourceLabel}
          allowFileSelection={false}
          timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
        />
      ) : !loading ? (
        <AiUsagePanel allowFileSelection={false} />
      ) : null}
    </div>
  );
}
