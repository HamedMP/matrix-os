"use client";

import { useState } from "react";
import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { brainMergeEvidenceText, brainScoreText } from "./brain-format.js";
import { BrainBadge, BrainError, BrainLoadMore, BrainView, type BrainScreenProps } from "./brain-ui.js";
import type { BrainEntityRefView, BrainMergeSuggestionView } from "./brain-types.js";
import { useBrainAction, useBrainPages } from "./use-brain-load.js";

const PAGE_SIZE = 10;
const EVIDENCE_SHOWN = 5;

/**
 * Possible duplicates: pairs of people the graph thinks are one person. Nothing merges by itself; Merge points the
 * second person at the first (the alias route with the suggestion's alias key), and Undo unmerges them, which leaves
 * nothing behind: the pair can be suggested and merged again.
 */
export function BrainPersonMerges({ api, projectId }: Pick<BrainScreenProps, "api" | "projectId">) {
  const pages = useBrainPages(
    (cursor) => api.mergeSuggestions(projectId, { limit: PAGE_SIZE, cursor }), "merge-suggestions",
  );
  return (
    <section aria-label="Possible duplicates" className="grid gap-2">
      <h2 className="text-sm font-semibold">Possible duplicates</h2>
      <BrainView state={pages.first.state} label="Looking for duplicates..." onRetry={pages.first.reload}>
        {(view) => (
          <div className="grid gap-2">
            {pages.items.length === 0 ? <p className="text-xs text-muted-foreground">No likely duplicates.</p> : (
              <ul className="grid gap-2">
                {pages.items.map((suggestion) => (
                  <MergeCard key={suggestion.suggestionId} api={api} projectId={projectId} suggestion={suggestion} />
                ))}
              </ul>
            )}
            {view.truncated && (
              <p className="text-xs text-muted-foreground">Only part of the people were checked; more may show later.</p>
            )}
            <BrainLoadMore nextCursor={pages.nextCursor} loading={pages.loadingMore} error={pages.moreError}
              onLoadMore={pages.loadMore} />
          </div>
        )}
      </BrainView>
    </section>
  );
}

function Person({ person, links, keeps }: {
  readonly person: BrainEntityRefView; readonly links: number; readonly keeps: boolean;
}) {
  return (
    <li className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
      <span className="font-medium text-foreground">{person.displayName}</span>
      <span className="min-w-0 break-all text-muted-foreground">{person.key}</span>
      <span className="text-muted-foreground">{links} {links === 1 ? "link" : "links"}</span>
      {keeps && <BrainBadge tone="good">stays</BrainBadge>}
    </li>
  );
}

function MergeCard({ api, projectId, suggestion }: Pick<BrainScreenProps, "api" | "projectId"> & {
  readonly suggestion: BrainMergeSuggestionView;
}) {
  const action = useBrainAction();
  const [merged, setMerged] = useState(false);
  const { entity, alias, aliasKey, counts } = suggestion;
  const update = (kind: "merge" | "unmerge") => action.run(kind,
    () => api.updateAlias(projectId, entity.entityId, { action: kind, aliasKey }), () => setMerged(kind === "merge"));
  const moving = counts.aliasEntities - 1;
  // Each reason once, so its words are its key.
  const reasons = [...new Set(suggestion.evidence.map(brainMergeEvidenceText))].slice(0, EVIDENCE_SHOWN);
  return (
    <li className={`grid gap-2 rounded-md border p-3 text-sm ${BRAIN_TONE.border}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Likely one person</span>
        <BrainBadge>{brainScoreText(suggestion.score)}</BrainBadge>
      </div>
      <ul aria-label="People" className="grid gap-1">
        <Person person={entity} links={counts.entityLinks} keeps />
        <Person person={alias} links={counts.aliasLinks} keeps={false} />
      </ul>
      {moving > 0 && (
        <p className="text-xs text-muted-foreground">
          {moving} more {moving === 1 ? "name moves" : "names move"} with {alias.displayName}.
        </p>
      )}
      {reasons.length > 0 && (
        <ul aria-label="Why" className="list-disc pl-5 text-xs text-muted-foreground">
          {reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {merged ? (
          <>
            <p role="status" className="text-xs">Merged {alias.displayName} into {entity.displayName}.</p>
            <BrainButton size="sm" variant="outline" disabled={action.busy !== null} onClick={() => update("unmerge")}>
              {action.busy === "unmerge" ? "Undoing..." : "Undo"}
            </BrainButton>
          </>
        ) : (
          <BrainButton size="sm" disabled={action.busy !== null} onClick={() => update("merge")}>
            {action.busy === "merge" ? "Merging..." : `Merge into ${entity.displayName}`}
          </BrainButton>
        )}
      </div>
      {action.error && <BrainError error={action.error} />}
    </li>
  );
}
