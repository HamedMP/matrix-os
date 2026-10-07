import { editionDate } from "./model";
import type { EditionSource } from "./types";
/** Shared, truthful status presentation for every Edition surface. */
export function sourceStatus(source: EditionSource): string[] {
  const state =
    {
      pending: "Import pending",
      running: "Import in progress",
      completed: "Import complete",
      not_synced: "Not synchronized yet",
      paused: "Importing stopped; retained editions remain available",
    }[source.state] ?? "Sync status unavailable";
  const lines = [
    `${state} · ${source.coverageStart ? "History from " + editionDate(source.coverageStart) : "History coverage not confirmed"}${source.coverageEnd ? " to " + editionDate(source.coverageEnd) : ""}`,
  ];
  if (source.availability === "disconnected")
    lines.push(
      "Email connection is disconnected. Reconnect in Matrix to import new editions.",
    );
  if (source.availability === "unknown")
    lines.push("Email connection availability could not be checked.");
  if (source.syncError)
    lines.push(
      "Sync needs another try. Your retained editions remain available.",
    );
  if (source.lastSyncedAt)
    lines.push("Last completed sync · " + editionDate(source.lastSyncedAt));
  if (
    source.retainedCount !== undefined &&
    source.classifiedCount !== undefined &&
    source.reviewPendingCount !== undefined &&
    source.partialCount !== undefined
  )
    lines.push(
      `${source.retainedCount} retained · ${source.classifiedCount} categorized · ${source.reviewPendingCount} to review · ${source.partialCount} partial`,
    );
  if (source.sharedWith)
    lines.push(
      source.sharedWith.length
        ? `History shared with ${source.sharedWith.map((app) => (app === "folio" ? "Folio" : "Atlas")).join(" and ")}.`
        : "Reading history is private to Edition.",
    );
  if (source.usedBytes !== undefined && source.quotaBytes !== undefined) {
    const units = (bytes: number) =>
      bytes >= 1024 ** 3
        ? (bytes / 1024 ** 3).toFixed(1) + " GB"
        : bytes >= 1024 ** 2
          ? (bytes / 1024 ** 2).toFixed(1) + " MB"
          : bytes >= 1024
            ? (bytes / 1024).toFixed(1) + " KB"
            : bytes + " bytes";
    lines.push(
      `Retained storage · ${units(source.usedBytes)} of ${units(source.quotaBytes)}`,
    );
    if (source.quotaBytes > 0 && source.usedBytes / source.quotaBytes >= 0.8)
      lines.push(
        "Your retained storage is nearly full. Imports stop at the limit; saved editions are never silently removed.",
      );
  }
  if (source.observed) {
    const o = source.observed;
    lines.push(
      `Observed account activity · ${o.connectorCalls} connector calls · ${o.reusedBodies} reused emails · ${o.aiClassificationCalls} AI categorizations`,
    );
    lines.push("Billed usage is not available.");
  }
  return lines;
}
