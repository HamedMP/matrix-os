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
  // Suggestions merged here. A card naming a person one of them merged away waits for its Undo: the gateway now
  // resolves that person to the one who stayed, so its Merge would join someone else and its Undo would fail.
  const [merged, setMerged] = useState<ReadonlySet<string>>(new Set());
  const mark = (id: string, on: boolean) => setMerged((previous) => {
    const next = new Set(previous);
    if (on) next.add(id); else next.delete(id);
    return next;
  });
  // One Merge or Undo at a time in the list: for chained cards (A <- B, B <- C) the order the gateway applied two
  // running at once in would decide whom the second joins. `acting` is the card of the running or last change.
  const action = useBrainAction();
  const [acting, setActing] = useState<string | null>(null);
  const update = ({ suggestionId, entity, aliasKey }: BrainMergeSuggestionView, kind: "merge" | "unmerge") => {
    setActing(suggestionId);
    action.run(kind, () => api.updateAlias(projectId, entity.entityId, { action: kind, aliasKey }),
      () => mark(suggestionId, kind === "merge"));
  };
  const away = pages.items.filter((item) => merged.has(item.suggestionId));
  const heldBy = ({ suggestionId, entity, alias }: BrainMergeSuggestionView) => away.find((item) =>
    item.suggestionId !== suggestionId && [entity.entityId, alias.entityId].includes(item.alias.entityId))?.alias;
  return (
    <section aria-label="Possible duplicates" className="grid gap-2">
      <h2 className="text-sm font-semibold">Possible duplicates</h2>
      <BrainView state={pages.first.state} label="Looking for duplicates..." onRetry={pages.first.reload}>
        {(view) => (
          <div className="grid gap-2">
            {pages.items.length === 0 ? <p className="text-xs text-muted-foreground">No likely duplicates.</p> : (
              <ul className="grid gap-2">
                {pages.items.map((suggestion) => (
                  <MergeCard key={suggestion.suggestionId} suggestion={suggestion} action={action}
                    mine={acting === suggestion.suggestionId} merged={merged.has(suggestion.suggestionId)}
                    heldBy={heldBy(suggestion)} onChange={(kind) => update(suggestion, kind)} />
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

interface MergeCardProps {
  readonly suggestion: BrainMergeSuggestionView; readonly merged: boolean;
  readonly onChange: (kind: "merge" | "unmerge") => void;
  /** The person of this card that another merge here moved away; Merge waits until that merge is undone. */
  readonly heldBy: BrainEntityRefView | undefined;
  /** The list's one change at a time; `mine` when it is (or last was) this card's, so its state shows here. */
  readonly action: ReturnType<typeof useBrainAction>; readonly mine: boolean;
}

function MergeCard({ suggestion, merged, heldBy, action, mine, onChange }: MergeCardProps) {
  const { entity, alias, counts } = suggestion;
  const locked = action.busy !== null;
  const running = mine ? action.busy : null;
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
            <BrainButton size="sm" variant="outline" disabled={locked} onClick={() => onChange("unmerge")}>
              {running === "unmerge" ? "Undoing..." : "Undo"}
            </BrainButton>
          </>
        ) : (
          <>
            <BrainButton size="sm" wrap className="max-w-full break-all"
              disabled={locked || heldBy !== undefined} onClick={() => onChange("merge")}>
              {running === "merge" ? "Merging..." : `Merge into ${entity.displayName}`}
            </BrainButton>
            {heldBy && <p className="text-xs text-muted-foreground">Undo the merge of {heldBy.displayName} first.</p>}
          </>
        )}
      </div>
      {mine && action.error && <BrainError error={action.error} />}
    </li>
  );
}
