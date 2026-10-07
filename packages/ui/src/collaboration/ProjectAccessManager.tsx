import {
  CollaborationGrantSchema,
  CollaborationProjectAccessPresentationSchema,
  CollaborationScopeSchema,
  OrganizationManagementListSchema,
  OrganizationManagementMembersPageSchema,
  type CollaborationGrant,
  type CollaborationPreset,
  type CollaborationProjectAccessPresentation,
  type CollaborationScope,
} from "@matrix-os/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const GrantsSchema = z.array(CollaborationGrantSchema).max(100);
const MAX_LOADED_ORGANIZATION_MEMBERS = 2_000;
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

function editorLabel(preset: CollaborationPreset): "Editor" | "Viewer" {
  return preset === "contributor" ? "Editor" : "Viewer";
}

function privatePresentation(scope: CollaborationScope, grants: CollaborationGrant[], members: Array<{ actorId: string; displayName: string }>): CollaborationProjectAccessPresentation {
  const names = new Map(members.map((member) => [member.actorId, member.displayName]));
  const organization = grants.find((grant) => grant.audience.kind === "organization"
    && (grant.state === "active" || grant.state === "pending"));
  const direct = grants.filter((grant) => grant.audience.kind === "member"
    && (grant.state === "active" || grant.state === "pending"));
  return CollaborationProjectAccessPresentationSchema.parse({
    scopeId: scope.id,
    revision: scope.revision,
    owner: { actorId: scope.ownerId, displayName: names.get(scope.ownerId) ?? scope.ownerId },
    generalAccess: organization ? { grantId: organization.id, preset: organization.preset, revision: organization.revision } : null,
    people: direct.map((grant) => {
      const actorId = grant.audience.kind === "member" ? grant.audience.actorId : "";
      return {
        actor: { actorId, displayName: names.get(actorId) ?? actorId },
        status: grant.state === "active" ? "active" : "pending",
        effectivePreset: grant.preset,
        inherited: false,
        directGrant: { grantId: grant.id, preset: grant.preset, revision: grant.revision },
      };
    }),
  });
}

export function ProjectAccessManager({ api, scope, organizationName, onChanged }: {
  api: CollaborationApi;
  scope: CollaborationScope;
  organizationName?: string | null;
  onChanged?: () => Promise<unknown>;
}) {
  const [access, setAccess] = useState<CollaborationProjectAccessPresentation | null>(null);
  const [organizationMembers, setOrganizationMembers] = useState<Array<{ actorId: string; displayName: string }>>([]);
  const [membersCursor, setMembersCursor] = useState<string | null>(null);
  const [membersPending, setMembersPending] = useState(false);
  const [selectedActor, setSelectedActor] = useState("");
  const [selectedPreset, setSelectedPreset] = useState<CollaborationPreset>("viewer");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [organizationDisplayName, setOrganizationDisplayName] = useState(organizationName ?? null);
  const alive = useRef(true);
  const base = `/api/collaboration/scopes/${encodeURIComponent(scope.id)}`;

  const load = useCallback(async () => {
    if (!scope.organizationId) throw new Error("Organization unavailable");
    const [memberValue, organizationValue] = await Promise.all([
      api.get(`/api/organizations/${encodeURIComponent(scope.organizationId)}/members`),
      organizationName ? Promise.resolve(null) : api.get("/api/organizations"),
    ]);
    const memberPage = OrganizationManagementMembersPageSchema.parse(memberValue);
    const listed = memberPage.members.map(({ actorId, displayName }) => ({ actorId, displayName }));
    let displayName = organizationName;
    if (!displayName) {
      const listing = OrganizationManagementListSchema.parse(organizationValue);
      const selected = listing.organizations.find((organization) => organization.organizationId === scope.organizationId);
      if (!selected) throw new Error("Organization unavailable");
      displayName = selected.name;
    }
    const next = scope.lifecycle === "shared" || scope.lifecycle === "archived"
      ? CollaborationProjectAccessPresentationSchema.parse(await api.get(`${base}/project/access`))
      : privatePresentation(
        CollaborationScopeSchema.parse(await api.get(base)),
        GrantsSchema.parse(await api.get(`${base}/grants`)),
        listed,
      );
    if (alive.current) {
      const directlyGrantedActors = new Set(next.people
        .filter((person) => person.directGrant)
        .map((person) => person.actor.actorId));
      const selectable = listed.filter((member) => member.actorId !== scope.ownerId
        && !directlyGrantedActors.has(member.actorId));
      setOrganizationDisplayName(displayName);
      setOrganizationMembers(listed);
      setMembersCursor(memberPage.nextCursor ?? null);
      setAccess(next);
      setSelectedActor((current) => selectable.some((member) => member.actorId === current)
        ? current : selectable[0]?.actorId ?? "");
      setError(false);
    }
    return next;
  }, [api, base, organizationName, scope.lifecycle, scope.organizationId, scope.ownerId]);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      await load();
    } catch (failure: unknown) {
      console.warn("[project-collaboration] access load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [load]);

  const loadMoreMembers = async () => {
    if (!scope.organizationId || !membersCursor || membersPending) return;
    const requestedCursor = membersCursor;
    setMembersPending(true);
    try {
      const page = OrganizationManagementMembersPageSchema.parse(await api.get(
        `/api/organizations/${encodeURIComponent(scope.organizationId)}/members?cursor=${encodeURIComponent(requestedCursor)}`,
      ));
      if (page.nextCursor === requestedCursor) throw new Error("Organization member cursor did not advance");
      if (alive.current) {
        const byActor = new Map(organizationMembers.map((member) => [member.actorId, member]));
        for (const { actorId, displayName } of page.members) byActor.set(actorId, { actorId, displayName });
        const merged = [...byActor.values()].slice(0, MAX_LOADED_ORGANIZATION_MEMBERS);
        const directlyGrantedActors = new Set(access?.people
          .filter((person) => person.directGrant)
          .map((person) => person.actor.actorId) ?? []);
        const selectable = merged.filter((member) => member.actorId !== scope.ownerId
          && !directlyGrantedActors.has(member.actorId));
        setOrganizationMembers(merged);
        setSelectedActor((current) => selectable.some((member) => member.actorId === current)
          ? current : selectable[0]?.actorId ?? "");
        setMembersCursor(merged.length >= MAX_LOADED_ORGANIZATION_MEMBERS
          ? null : page.nextCursor ?? null);
        setError(false);
      }
    } catch (failure: unknown) {
      console.warn("[project-collaboration] member page load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setMembersPending(false);
    }
  };

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => { alive.current = false; };
  }, [reload]);

  const mutate = async (operation: (current: CollaborationProjectAccessPresentation) => Promise<unknown>) => {
    if (!access || pending || membersPending) return;
    setPending(true);
    setError(false);
    try {
      await operation(access);
      await onChanged?.();
      await load();
    } catch (failure: unknown) {
      console.warn("[project-collaboration] access mutation failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally {
      if (alive.current) setPending(false);
    }
  };

  const setGeneralAccess = (value: CollaborationPreset | "restricted") => void mutate(async (current) => {
    const general = current.generalAccess;
    if (value === "restricted") {
      if (!general) return;
      await api.delete(`${base}/grants/${encodeURIComponent(general.grantId)}`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
        expectedMemberRevision: general.revision,
      });
      return;
    }
    if (general) {
      if (general.preset === value) return;
      if (!api.patch) throw new Error("Access editing unavailable");
      await api.patch(`${base}/grants/${encodeURIComponent(general.grantId)}`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
        expectedGrantRevision: general.revision, preset: value,
      });
      return;
    }
    await api.post(`${base}/grants`, {
      clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
      audience: { kind: "organization" }, preset: value,
    });
  });

  const addMember = () => void mutate(async (current) => {
    if (!selectedActor || selectedActor === scope.ownerId) throw new Error("Member unavailable");
    await api.post(`${base}/grants`, {
      clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
      audience: { kind: "member", actorId: selectedActor }, preset: selectedPreset,
    });
  });

  const availableMembers = useMemo(() => {
    const directlyGranted = new Set(access?.people
      .filter((person) => person.directGrant)
      .map((person) => person.actor.actorId) ?? []);
    return organizationMembers.filter((member) => member.actorId !== scope.ownerId
      && !directlyGranted.has(member.actorId));
  }, [access?.people, organizationMembers, scope.ownerId]);

  return <section aria-labelledby="project-access-heading" className="grid gap-4">
    <div>
      <h3 id="project-access-heading" className="font-medium">People with access</h3>
      <p className="mt-1 text-xs" style={{ color: "var(--text-secondary)" }}>
        Members activate organization access when they open this project.
      </p>
    </div>
    {loading ? <p role="status" className="text-sm">Loading access…</p> : null}
    {error ? <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>Access is unavailable. Refresh and try again.</span>
      <button type="button" className={buttonClass} disabled={loading || pending} onClick={() => { void reload(); }}>
        Refresh access
      </button>
    </div> : null}
    {access ? <>
      <div className="flex items-center gap-3 rounded-xl border px-3 py-2">
        <span aria-hidden className="grid size-8 place-items-center rounded-full bg-[var(--bg-hover)] text-xs font-semibold">
          {access.owner.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{access.owner.displayName}</span>
        <span className="text-sm">Owner</span>
      </div>
      {access.people.map((person) => {
        const organizationEditor = access.generalAccess?.preset === "contributor" && person.inherited;
        const directGrant = person.directGrant;
        return <div key={person.actor.actorId} className="flex items-center gap-3 rounded-xl border px-3 py-2">
          <span aria-hidden className="grid size-8 place-items-center rounded-full bg-[var(--bg-hover)] text-xs font-semibold">
            {person.actor.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{person.actor.displayName}</span>
            <span className="block text-xs" style={{ color: "var(--text-secondary)" }}>
              {person.status === "pending" ? "Pending until opened" : person.inherited ? "Inherited from general access" : "Direct access"}
            </span>
          </span>
          {directGrant && !organizationEditor ? <select
            aria-label={`Access for ${person.actor.displayName}`}
            value={directGrant.preset}
            disabled={pending || membersPending}
            onChange={(event) => {
              const preset = event.target.value as CollaborationPreset;
              void mutate(async (current) => {
                if (!api.patch) throw new Error("Access editing unavailable");
                await api.patch(`${base}/grants/${encodeURIComponent(directGrant.grantId)}`, {
                  clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
                  expectedGrantRevision: directGrant.revision,
                  preset,
                });
              });
            }}
            className="rounded-lg border bg-transparent px-3 py-2 text-sm">
            <option value="contributor">Editor</option><option value="viewer">Viewer</option>
          </select> : <span className="text-sm">
            {editorLabel(person.effectivePreset)}{organizationEditor ? " · inherited" : ""}
          </span>}
          {directGrant ? <button type="button" className={buttonClass} disabled={pending || membersPending}
            onClick={() => void mutate((current) => api.delete(`${base}/grants/${encodeURIComponent(directGrant.grantId)}`, {
              clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
              expectedMemberRevision: directGrant.revision,
            }))}>Revoke</button> : null}
        </div>;
      })}
      {availableMembers.length > 0 && access.generalAccess?.preset !== "contributor" ? <div className="grid gap-2 sm:grid-cols-[1fr_8rem_auto]">
        <label className="grid gap-1 text-sm">Add person
          <select value={selectedActor} onChange={(event) => setSelectedActor(event.target.value)} disabled={pending || membersPending}
            className="rounded-lg border bg-transparent px-3 py-2">
            {availableMembers.map((member) => <option key={member.actorId} value={member.actorId}>{member.displayName}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-sm">Role
          <select value={selectedPreset} onChange={(event) => setSelectedPreset(event.target.value as CollaborationPreset)} disabled={pending || membersPending}
            className="rounded-lg border bg-transparent px-3 py-2">
            <option value="contributor">Editor</option><option value="viewer">Viewer</option>
          </select>
        </label>
        <button type="button" className={`${buttonClass} self-end`} disabled={pending || membersPending || !selectedActor} onClick={addMember}>Add</button>
      </div> : null}
      {membersCursor && access.generalAccess?.preset !== "contributor" ? <button type="button" className={buttonClass}
        disabled={pending || membersPending} onClick={() => { void loadMoreMembers(); }}>
        {membersPending ? "Loading members…" : "Load more members"}
      </button> : null}
      <div className="flex items-center gap-3 rounded-xl border px-3 py-3">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Everyone in {organizationDisplayName ?? "your organization"}</span>
          <span className="block text-xs" style={{ color: "var(--text-secondary)" }}>General access</span>
        </span>
        <label className="sr-only" htmlFor={`general-access-${scope.id}`}>General access</label>
        <select id={`general-access-${scope.id}`} aria-label="General access"
          value={access.generalAccess?.preset ?? "restricted"} disabled={pending || membersPending}
          onChange={(event) => setGeneralAccess(event.target.value as CollaborationPreset | "restricted")}
          className="rounded-lg border bg-transparent px-3 py-2 text-sm">
          <option value="contributor">Editor</option><option value="viewer">Viewer</option><option value="restricted">Restricted</option>
        </select>
      </div>
    </> : null}
  </section>;
}
