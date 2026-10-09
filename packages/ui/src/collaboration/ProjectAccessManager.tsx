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
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Check, ChevronDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const GrantsSchema = z.array(CollaborationGrantSchema).max(100);
const MAX_LOADED_ORGANIZATION_MEMBERS = 2_000;
const buttonClass = "inline-flex h-7 items-center justify-center rounded-lg border px-2.5 text-xs font-medium transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";
const roleTriggerClass = "inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs outline-none hover:bg-[var(--bg-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50";
const roleMenuClass = "z-[100] min-w-[188px] rounded-[10px] border p-1 shadow-[0_10px_30px_rgba(0,0,0,0.14)]";
const roleItemClass = "relative flex cursor-default select-none items-start gap-2 rounded-md px-2 py-1.5 text-xs outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-[var(--bg-hover)]";

function editorLabel(preset: CollaborationPreset): "Editor" | "Viewer" {
  return preset === "contributor" ? "Editor" : "Viewer";
}

function AccessRoleMenu({ ariaLabel, value, disabled, allowRestricted = false, onSelect, onRemove }: {
  ariaLabel: string;
  value: CollaborationPreset | "restricted";
  disabled: boolean;
  allowRestricted?: boolean;
  onSelect: (value: CollaborationPreset | "restricted") => void;
  onRemove?: () => void;
}) {
  const label = value === "restricted" ? "Restricted" : editorLabel(value);
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className={roleTriggerClass} disabled={disabled} aria-label={`${ariaLabel}: ${label}`}>
        {label}<ChevronDown aria-hidden size={13} />
      </button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end" sideOffset={4} className={roleMenuClass}
      style={{ background: "var(--bg-overlay, var(--popover, #fffefc))", color: "var(--text-primary)", borderColor: "var(--border-default)" }}>
      <RoleMenuItem label="Editor" description="Change files and request AI" selected={value === "contributor"}
        onSelect={() => onSelect("contributor")} />
      <RoleMenuItem label="Viewer" description="View project activity only" selected={value === "viewer"}
        onSelect={() => onSelect("viewer")} />
      {allowRestricted ? <RoleMenuItem label="Restricted" description="Only people added directly can open it"
        selected={value === "restricted"} onSelect={() => onSelect("restricted")} /> : null}
      {onRemove ? <>
        <DropdownMenu.Separator className="my-1 h-px" style={{ background: "var(--border-subtle, var(--border-default))" }} />
        <DropdownMenu.Item className={roleItemClass} style={{ color: "var(--danger, #dc2626)" }} onSelect={onRemove}>
          Remove access
        </DropdownMenu.Item>
      </> : null}
    </DropdownMenu.Content>
  </DropdownMenu.Root>;
}

function RoleMenuItem({ label, description, selected, onSelect }: {
  label: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return <DropdownMenu.Item className={roleItemClass} aria-label={`${label} ${description}`} onSelect={onSelect}>
    <span className="min-w-0 flex-1">
      <span className="block font-medium">{label}</span>
      <span className="block text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>{description}</span>
    </span>
    {selected ? <Check aria-hidden size={13} className="mt-0.5 shrink-0" /> : null}
  </DropdownMenu.Item>;
}

function MemberAvatar({ name }: { name: string }) {
  return <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-medium"
    style={{ background: "var(--bg-hover, #f5f5f5)", color: "var(--text-secondary)" }}>
    {name.slice(0, 1).toUpperCase()}
  </span>;
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
  const [selectedPreset, setSelectedPreset] = useState<CollaborationPreset>("contributor");
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

  return <section aria-labelledby="project-access-heading" className="grid gap-1 px-4 py-3" data-slot="project-access-manager">
    <h3 id="project-access-heading" className="mb-1 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
      People with access
    </h3>
    {loading ? <p role="status" className="text-sm">Loading access…</p> : null}
    {error ? <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border p-3 text-sm">
      <span>Access is unavailable. Refresh and try again.</span>
      <button type="button" className={buttonClass} disabled={loading || pending} onClick={() => { void reload(); }}>
        Refresh access
      </button>
    </div> : null}
    {access ? <>
      <div className="flex min-h-10 items-center gap-3 py-1">
        <MemberAvatar name={access.owner.displayName} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{access.owner.displayName} (you)</span>
          <span className="block truncate text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
            Created this · lives on {access.owner.displayName}’s computer
          </span>
        </span>
        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>Owner</span>
      </div>
      {access.people.map((person) => {
        const organizationEditor = access.generalAccess?.preset === "contributor" && person.inherited;
        const directGrant = person.directGrant;
        return <div key={person.actor.actorId} className="flex min-h-10 items-center gap-3 py-1">
          <MemberAvatar name={person.actor.displayName} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{person.actor.displayName}</span>
            <span className="block text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>
              {person.status === "pending" ? "Pending until opened" : person.inherited ? "Inherited from general access" : "Direct access"}
            </span>
          </span>
          {directGrant && !organizationEditor ? <AccessRoleMenu
            ariaLabel={`Access for ${person.actor.displayName}`}
            value={directGrant.preset}
            disabled={pending || membersPending}
            onSelect={(preset) => void mutate(async (current) => {
              if (preset === "restricted") return;
              if (!api.patch) throw new Error("Access editing unavailable");
              await api.patch(`${base}/grants/${encodeURIComponent(directGrant.grantId)}`, {
                clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
                expectedGrantRevision: directGrant.revision,
                preset,
              });
            })}
            onRemove={() => void mutate((current) => api.delete(`${base}/grants/${encodeURIComponent(directGrant.grantId)}`, {
              clientRequestId: crypto.randomUUID(), expectedRevision: current.revision,
              expectedMemberRevision: directGrant.revision,
            }))}
          /> : <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
            {editorLabel(person.effectivePreset)}{organizationEditor ? " · inherited" : ""}
          </span>}
        </div>;
      })}
      {availableMembers.length > 0 && access.generalAccess?.preset !== "contributor" ? <div className="my-1 flex items-center gap-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Add person</span>
          <select aria-label="Add person" value={selectedActor} onChange={(event) => setSelectedActor(event.target.value)} disabled={pending || membersPending}
            className="h-8 w-full rounded-lg border bg-transparent px-2.5 text-xs outline-none focus:ring-2 focus:ring-[var(--accent)]"
            style={{ borderColor: "var(--border-default)" }}>
            {availableMembers.map((member) => <option key={member.actorId} value={member.actorId}>{member.displayName}</option>)}
          </select>
        </label>
        <label>
          <span className="sr-only">Role</span>
          <select aria-label="Role" value={selectedPreset} onChange={(event) => setSelectedPreset(event.target.value as CollaborationPreset)} disabled={pending || membersPending}
            className="h-8 rounded-lg border bg-transparent px-2 text-xs outline-none" style={{ borderColor: "var(--border-default)" }}>
            <option value="contributor">Editor</option><option value="viewer">Viewer</option>
          </select>
        </label>
        <button type="button" aria-label="Add" className="h-8 rounded-lg bg-[var(--text-primary)] px-3 text-xs font-medium text-[var(--bg-surface)] disabled:opacity-50"
          disabled={pending || membersPending || !selectedActor} onClick={addMember}>Invite</button>
      </div> : null}
      {membersCursor && access.generalAccess?.preset !== "contributor" ? <button type="button" className={buttonClass}
        disabled={pending || membersPending} onClick={() => { void loadMoreMembers(); }}>
        {membersPending ? "Loading members…" : "Load more members"}
      </button> : null}
      <h3 className="mb-1 mt-2 text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>General access</h3>
      <div className="flex min-h-10 items-center gap-3 py-1">
        <span aria-label={`${organizationDisplayName ?? "Organization"} organization`}
          className="grid size-7 shrink-0 place-items-center rounded-md text-[11px] font-semibold text-white"
          style={{ background: "var(--success, #6f9947)" }}>
          {(organizationDisplayName ?? "O").slice(0, 1).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">Everyone in {organizationDisplayName ?? "your organization"}</span>
          <span className="block text-[10px] leading-4" style={{ color: "var(--text-secondary)" }}>Members can find and open it</span>
        </span>
        <AccessRoleMenu ariaLabel="General access" value={access.generalAccess?.preset ?? "restricted"}
          disabled={pending || membersPending} allowRestricted onSelect={setGeneralAccess} />
      </div>
    </> : null}
  </section>;
}
