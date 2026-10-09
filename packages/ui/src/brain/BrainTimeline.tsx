"use client";

import { useState, type FormEvent } from "react";
import { BrainButton, BrainInput, BrainSelect } from "./brain-controls.js";
import { BRAIN_TONE } from "./brain-tone.js";
import {
  BrainBadge, BrainCite, BrainEmpty, BrainFreshness, BrainLoadMore, BrainView, type BrainScreenProps,
} from "./brain-ui.js";
import { brainTimelineRef } from "./brain-format.js";
import { BrainPersonMerges } from "./BrainPersonMerges.js";
import type { BrainTimelineItemView } from "./brain-types.js";
import { useBrainPages } from "./use-brain-load.js";

type TimelineKind = "file" | "person" | "spec";
const PAGE_SIZE = 20;
const PEOPLE_LIMIT = 10;
/** Equal to the gateway's entity name query bound. */
const BRAIN_ENTITY_QUERY_MAX_CHARS = 200;
const KIND_HINT: Readonly<Record<TimelineKind, string>> = {
  file: "packages/gateway/src/brain/why.ts (end a folder with /)",
  person: "A name or email",
  spec: "specs/551-company-brain-store",
};

/** Timeline: every document touching a file, folder, person or spec, newest first. */
export function BrainTimeline({ api, projectId, onOpenSources }: BrainScreenProps) {
  const [kind, setKind] = useState<TimelineKind>("file");
  const [draft, setDraft] = useState("");
  const [entity, setEntity] = useState("");
  const [person, setPerson] = useState("");
  // Counts the requests sent, so showing the same one again reads it again.
  const [sent, setSent] = useState(0);
  const people = useBrainPages(
    (cursor) => api.entities(projectId, { kind: "person", q: person, limit: PEOPLE_LIMIT, cursor }),
    person === "" ? null : `${sent}:${person}`,
  );
  const pages = useBrainPages(
    (cursor) => api.timeline(projectId, { entity, limit: PAGE_SIZE, cursor }),
    entity === "" ? null : `${sent}:${entity}`,
  );

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = draft.trim();
    if (value === "") return;
    setSent(sent + 1);
    if (kind === "person") {
      setEntity("");
      setPerson(value.slice(0, BRAIN_ENTITY_QUERY_MAX_CHARS));
    } else {
      setPerson("");
      setEntity(brainTimelineRef(kind, value));
    }
  };

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label="Choose what to follow">
        <BrainSelect aria-label="Timeline for" value={kind} onChange={(event) => setKind(event.target.value as TimelineKind)}>
          <option value="file">File or folder</option>
          <option value="person">Person</option>
          <option value="spec">Spec</option>
        </BrainSelect>
        <BrainInput aria-label="Name, path or spec" placeholder={KIND_HINT[kind]} value={draft} maxLength={1_024}
          onChange={(event) => setDraft(event.target.value)} className="min-w-0 flex-1 basis-56" />
        <BrainButton type="submit">Show</BrainButton>
      </form>
      {kind === "person" && <BrainPersonMerges api={api} projectId={projectId} />}
      {entity === "" && person === "" && (
        <BrainEmpty title="Pick a file, a person or a spec.">The timeline lists the pull requests, commits and specs that touched it.</BrainEmpty>
      )}
      <BrainView state={people.first.state} label="Finding people..." onRetry={people.first.reload}
        onOpenSources={onOpenSources}>
        {() => people.items.length === 0 ? (
          <BrainEmpty title={`No one called "${person}" yet.`}>Try part of the name, or an email.</BrainEmpty>
        ) : (<>
          <ul aria-label="People" className="flex flex-wrap gap-2">
            {people.items.map((match) => (
              <li key={match.entityId} className="min-w-0 max-w-full">
                <BrainButton size="sm" variant="outline" wrap className="max-w-full break-all text-left"
                  onClick={() => { setPerson(""); setEntity(match.entityId); }}>
                  {match.displayName} <span className="text-xs text-muted-foreground">{match.key}</span>
                </BrainButton>
              </li>
            ))}
          </ul>
          <BrainLoadMore nextCursor={people.nextCursor} loading={people.loadingMore} error={people.moreError}
            onLoadMore={people.loadMore} />
        </>)}
      </BrainView>
      <BrainView state={pages.first.state} label="Loading the timeline..." onRetry={pages.first.reload}
        onOpenSources={onOpenSources}>
        {(view) => (
          <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
            <h2 className="break-words text-base font-semibold">{view.entity.displayName}</h2>
            <BrainFreshness pending={view.freshness.pendingDocuments} capped={view.freshness.pendingCapped} />
            {pages.items.length === 0 ? (
              <BrainEmpty title="Nothing touches this yet.">Check the name, or sync its sources in Sources.</BrainEmpty>
            ) : (
              <ol aria-label="Timeline" className={`grid gap-2 border-l pl-4 ${BRAIN_TONE.border}`}>
                {pages.items.map((item) => <TimelineItem key={item.cite.documentId} item={item} />)}
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

function TimelineItem({ item }: { readonly item: BrainTimelineItemView }) {
  return (
    <li className={`grid min-w-0 gap-1 rounded-md border p-2 ${BRAIN_TONE.border}`}>
      <BrainCite cite={item.cite} />
      <div className="flex flex-wrap items-center gap-1.5">
        {item.linkTypes.map((type) => <BrainBadge key={type}>{type.replace(/_/g, " ")}</BrainBadge>)}
        {item.mode === "inferred" && <BrainBadge tone="warn">inferred</BrainBadge>}
      </div>
      {item.matchedPaths.length > 0 && (
        <p className="truncate text-xs text-muted-foreground">{item.matchedPaths.join(", ")}</p>
      )}
    </li>
  );
}
