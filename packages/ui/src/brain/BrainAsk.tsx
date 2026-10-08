"use client";

import { useState, type FormEvent } from "react";
import { Search } from "lucide-react";
import { BrainButton, BrainInput, BrainSelect } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import { brainAskPath } from "./brain-format.js";
import {
  BrainBadge, BrainCite, BrainEmpty, BrainFreshness, BrainLoadMore, BrainSnippet, BrainView, type BrainScreenProps,
} from "./brain-ui.js";
import type { BrainSearchHitView } from "./brain-types.js";
import { BrainPathHistory } from "./BrainPathHistory.js";
import { useBrainPages } from "./use-brain-load.js";

/** Equal to the gateway's BRAIN_SEARCH_Q_MAX_CHARS. */
const BRAIN_ASK_MAX_CHARS = 500;
const PAGE_SIZE = 20;
type AskScope = "all" | "document" | "claim";
const SCOPE_TYPES: Readonly<Record<AskScope, readonly ("document" | "claim")[]>> = {
  all: [], document: ["document"], claim: ["claim"],
};

/**
 * Ask: ranked search over the project's documents and claims; every hit shows where it came from. A question that
 * looks like a repo path (`packages/gateway/src/brain/why.ts`) shows that path's history instead.
 */
export function BrainAsk({ api, projectId, onOpenSources }: BrainScreenProps) {
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<AskScope>("all");
  // `path` is the repo path the question names (its history is shown), or null to search the words.
  const [asked, setAsked] = useState<{ q: string; scope: AskScope; path: string | null }>({ q: "", scope: "all", path: null });
  const pages = useBrainPages(
    (cursor) => api.search(projectId, { q: asked.q, types: SCOPE_TYPES[asked.scope], limit: PAGE_SIZE, cursor }),
    asked.q === "" || asked.path !== null ? null : `${asked.scope}:${asked.q}`,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const q = draft.trim().slice(0, BRAIN_ASK_MAX_CHARS);
    if (q !== "") setAsked({ q, scope, path: brainAskPath(q) });
  };

  // One shrinkable column (as on Today): results wrap at 390 px instead of widening the screen.
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <form role="search" onSubmit={submit} className="flex flex-wrap items-center gap-2">
        <BrainInput
          type="search"
          aria-label="Ask the Company Brain"
          placeholder="Why did we choose Postgres for app data?"
          maxLength={BRAIN_ASK_MAX_CHARS}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 basis-56"
        />
        <BrainSelect aria-label="Search in" value={scope} onChange={(event) => setScope(event.target.value as AskScope)}>
          <option value="all">Everything</option>
          <option value="document">Documents</option>
          <option value="claim">Claims</option>
        </BrainSelect>
        <BrainButton type="submit"><Search className="size-4" aria-hidden="true" />Search</BrainButton>
      </form>
      {asked.q === "" && (
        <BrainEmpty title="Ask about a decision, a file, a person or a pull request.">
          Every answer links to the pull request, commit, spec or note it came from. Type a path, like
          packages/gateway/src/brain/why.ts, to see its history.
        </BrainEmpty>
      )}
      {asked.path !== null && (
        <BrainPathHistory api={api} projectId={projectId} onOpenSources={onOpenSources} path={asked.path}
          onSearchWords={() => setAsked({ ...asked, path: null })} />
      )}
      <BrainView state={pages.first.state} label="Searching..." onRetry={pages.first.reload} onOpenSources={onOpenSources}>
        {(view) => (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            <BrainFreshness pending={view.freshness.pendingDocuments} capped={view.freshness.pendingCapped} />
            {pages.items.length === 0 ? (
              <BrainEmpty title={`No results for "${view.q}".`}>Try other words, or fewer of them.</BrainEmpty>
            ) : (
              <ol aria-label="Results" className="grid grid-cols-[minmax(0,1fr)] gap-3">
                {pages.items.map((hit) => <AskHit key={hit.hitId} hit={hit} />)}
              </ol>
            )}
            <BrainLoadMore nextCursor={pages.nextCursor} loading={pages.loadingMore} error={pages.moreError}
              onLoadMore={pages.loadMore} />
          </div>
        )}
      </BrainView>
    </div>
  );
}

function AskHit({ hit }: { readonly hit: BrainSearchHitView }) {
  return (
    <li className={`grid min-w-0 gap-2 rounded-md border p-3 ${BRAIN_TONE.border}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <BrainBadge>{hit.claim === null ? hit.cite.kind : hit.claim.kind}</BrainBadge>
        {hit.claim?.stale === true && <BrainBadge tone="warn">Outdated</BrainBadge>}
      </div>
      {hit.claim !== null && <p className="text-sm font-medium">{hit.claim.statement}</p>}
      <BrainSnippet text={hit.snippet.text} highlights={hit.snippet.highlights} />
      <BrainCite cite={hit.cite} />
    </li>
  );
}
