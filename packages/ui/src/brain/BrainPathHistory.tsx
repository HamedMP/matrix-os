"use client";

import { BrainButton } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { BrainBadge, BrainCite, BrainEmpty, BrainLoadMore, BrainView, type BrainScreenProps } from "./brain-ui.js";
import type { BrainWhyItem } from "./brain-types.js";
import { useBrainPages } from "./use-brain-load.js";

const PAGE_SIZE = 20;
const KIND_LABELS: Readonly<Record<BrainWhyItem["kind"], string>> = { pr: "pull request", commit: "commit", spec: "spec" };
const MATCHED_SHOWN = 3;

/**
 * The history of one repo path (the why route): every pull request, commit and spec that touched it, newest first.
 * "Search the words instead" sits outside the loaded view, so it works while loading and after any error too.
 */
export function BrainPathHistory({ api, projectId, onOpenSources, path, ask, onSearchWords }: BrainScreenProps & {
  readonly path: string; readonly ask: number; readonly onSearchWords: () => void;
}) {
  const pages = useBrainPages(
    (cursor) => api.why(projectId, { path, limit: PAGE_SIZE, cursor, detail: "brief" }), `why:${path}`, ask,
  );
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 break-all text-base font-semibold">History of {path}</h2>
        <BrainButton size="sm" variant="ghost" onClick={onSearchWords}>Search the words instead</BrainButton>
      </div>
      <BrainView state={pages.first.state} label="Reading the history..." onRetry={pages.first.reload}
        onOpenSources={onOpenSources}>
        {(view) => (
          <div className="grid gap-3">
            {view.source === null ? (
              <BrainEmpty title="This project's repository is not connected.">
                <BrainButton size="sm" variant="outline" onClick={onOpenSources}>Open Sources</BrainButton>
              </BrainEmpty>
            ) : pages.items.length === 0 ? (
              <BrainEmpty title={`Nothing in the history touches "${view.path}" yet.`}>
                Check the path, or sync the repository in Sources.
              </BrainEmpty>
            ) : (
              <>
                <p className="text-xs text-muted-foreground">
                  {view.total}{view.totalCapped ? "+" : ""} {view.total === 1 ? "change" : "changes"}, newest first.
                </p>
                <ol aria-label="Path history" className={`grid gap-2 border-l pl-4 ${BRAIN_TONE.border}`}>
                  {pages.items.map((item) => <PathItem key={item.documentId} item={item} />)}
                </ol>
              </>
            )}
            <BrainLoadMore nextCursor={pages.nextCursor} loading={pages.loadingMore} error={pages.moreError}
              onLoadMore={pages.loadMore} />
          </div>
        )}
      </BrainView>
    </div>
  );
}

function PathItem({ item }: { readonly item: BrainWhyItem }) {
  const more = item.matchedPathCount - Math.min(item.matchedPaths.length, MATCHED_SHOWN);
  return (
    <li className={`grid gap-1 rounded-md border p-2 ${BRAIN_TONE.border}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <BrainBadge>{KIND_LABELS[item.kind]}</BrainBadge>
        {item.link === "inferred" && <BrainBadge tone="warn">number inferred</BrainBadge>}
      </div>
      <BrainCite cite={item} />
      {item.summary !== null && (
        <p className="whitespace-pre-line text-sm">{item.summary.text}{item.summary.truncated ? "..." : ""}</p>
      )}
      {item.matchedPaths.length > 0 && (
        <p className="truncate text-xs text-muted-foreground">
          {item.matchedPaths.slice(0, MATCHED_SHOWN).join(", ")}{more > 0 ? ` and ${more} more` : ""}
        </p>
      )}
    </li>
  );
}
