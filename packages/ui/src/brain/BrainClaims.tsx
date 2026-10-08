"use client";

import { useState, type FormEvent } from "react";
import { BrainButton, BrainInput } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BrainBadge, BrainCite, BrainEmpty, BrainLoadMore, BrainView, type BrainScreenProps,
} from "./brain-ui.js";
import { BRAIN_CONFLICTS_LIMIT, BRAIN_CONFLICTS_MAX, brainConflictFlags } from "./brain-format.js";
import type {
  BrainClaimKind, BrainClaimView, BrainConflictView, BrainConflictsView, BrainShellClient,
} from "./brain-types.js";
import { useBrainLoad, useBrainPages } from "./use-brain-load.js";

const PAGE_SIZE = 50;
/** Equal to the gateway's BRAIN_WHY_PATH_INPUT_MAX_CHARS. */
const BRAIN_PATH_MAX_CHARS = 1_024;

const KIND_TEXT: Readonly<Record<BrainClaimKind, { readonly plural: string; readonly noun: string }>> = {
  invariant: { plural: "Invariants", noun: "invariants" },
  decision: { plural: "Decisions", noun: "decisions" },
  commitment: { plural: "Commitments", noun: "commitments" },
  risk: { plural: "Risks", noun: "risks" },
};

/**
 * Every conflict page up to BRAIN_CONFLICTS_MAX, so a claim on a later page is flagged too; `nextCursor` is left set
 * when more were cut. A failed page fails the whole read, never a partial set of flags. One page per request, at most
 * BRAIN_CONFLICTS_MAX / BRAIN_CONFLICTS_LIMIT requests, each with the client's timeout.
 */
async function readConflicts(api: BrainShellClient, projectId: string): Promise<BrainConflictsView> {
  const items: BrainConflictView[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < BRAIN_CONFLICTS_MAX / BRAIN_CONFLICTS_LIMIT; page += 1) {
    const view = await api.conflicts(projectId, { limit: BRAIN_CONFLICTS_LIMIT, ...(cursor === null ? {} : { cursor }) });
    items.push(...view.items);
    cursor = view.nextCursor;
    if (cursor === null || items.length >= BRAIN_CONFLICTS_MAX) break;
  }
  return { items: items.slice(0, BRAIN_CONFLICTS_MAX), nextCursor: cursor };
}

/** Decisions, Commitments or Risks: claims with a verbatim quote, filtered by path, flagged when they conflict. */
export function BrainClaims({ api, projectId, onOpenSources, kind }: BrainScreenProps & { readonly kind: BrainClaimKind }) {
  const [draft, setDraft] = useState("");
  const [path, setPath] = useState("");
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const pages = useBrainPages(
    (cursor) => api.claims(projectId, { kind, path, limit: PAGE_SIZE, cursor }), `${kind}:${path}`,
  );
  const conflicts = useBrainLoad(() => readConflicts(api, projectId), "conflicts");
  const flags = brainConflictFlags(conflicts.state);
  const text = KIND_TEXT[kind];
  const shown = onlyFlagged ? pages.items.filter((claim) => flags.has(claim.claimId)) : pages.items;

  const apply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPath(draft.trim().slice(0, BRAIN_PATH_MAX_CHARS));
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <h2 className="text-base font-semibold">{text.plural}</h2>
      <form onSubmit={apply} className="flex flex-wrap items-center gap-2" aria-label={`Filter ${text.noun}`}>
        <BrainInput
          aria-label="File or folder"
          placeholder="packages/gateway/src/brain/ (optional)"
          maxLength={BRAIN_PATH_MAX_CHARS}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="min-w-0 flex-1 basis-56"
        />
        <BrainButton type="submit" variant="outline">Filter</BrainButton>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyFlagged} onChange={(event) => setOnlyFlagged(event.target.checked)} />
          Only conflicts
        </label>
      </form>
      {conflicts.state.status === "error" && (
        <p role="status" className="text-xs text-muted-foreground">Conflict checks are not available right now.</p>
      )}
      {conflicts.state.status === "ready" && conflicts.state.data.nextCursor !== null && (
        <p role="status" className="text-xs text-muted-foreground">
          Only the first {BRAIN_CONFLICTS_MAX} conflicts are checked.
        </p>
      )}
      <BrainView state={pages.first.state} label={`Loading ${text.noun}...`} onRetry={pages.first.reload}
        onOpenSources={onOpenSources}>
        {() => (
          <div className="grid gap-3">
            {shown.length === 0 ? (
              <BrainEmpty title={`No ${text.noun} found.`}>
                {path === "" && !onlyFlagged ? (
                  <>
                    Sync the repository and find claims in Sources.{" "}
                    <BrainButton size="sm" variant="link" onClick={onOpenSources}>Open Sources</BrainButton>
                  </>
                ) : "Try another path or clear the filters."}
              </BrainEmpty>
            ) : (
              <ul aria-label={text.plural} className="grid gap-3">
                {shown.map((claim) => (
                  <ClaimItem key={`${claim.claimId}:${claim.extractor}`} claim={claim} conflict={flags.get(claim.claimId)} />
                ))}
              </ul>
            )}
            <BrainLoadMore nextCursor={pages.nextCursor} loading={pages.loadingMore} error={pages.moreError}
              onLoadMore={pages.loadMore} />
          </div>
        )}
      </BrainView>
    </div>
  );
}

function ClaimItem({ claim, conflict }: { readonly claim: BrainClaimView; readonly conflict: string | undefined }) {
  const { fields } = claim;
  return (
    <li className={`grid gap-2 rounded-md border p-3 ${BRAIN_TONE.border}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {claim.label && <BrainBadge>{claim.label}</BrainBadge>}
        {conflict !== undefined && <BrainBadge tone="warn">Conflict</BrainBadge>}
        {claim.stale && <BrainBadge tone="warn">Outdated</BrainBadge>}
        {fields.due && <BrainBadge>Due {fields.due}</BrainBadge>}
        {fields.assignee && <BrainBadge>{fields.assignee}</BrainBadge>}
        {fields.severity && <BrainBadge tone={fields.severity === "high" ? "warn" : "plain"}>{fields.severity} risk</BrainBadge>}
        <BrainBadge>{claim.confidence} confidence</BrainBadge>
        <BrainBadge>{claim.extractor.startsWith("model:") ? "read by model" : "read by rules"}</BrainBadge>
      </div>
      <p className="text-sm font-medium">{claim.statement}</p>
      {conflict !== undefined && <p className={`text-xs ${BRAIN_TONE.warnText}`}>{conflict}</p>}
      <blockquote className={`border-l-2 pl-3 text-xs whitespace-pre-wrap text-muted-foreground ${BRAIN_TONE.border}`}>
        {claim.quote}
      </blockquote>
      <BrainCite cite={claim.document} />
    </li>
  );
}
