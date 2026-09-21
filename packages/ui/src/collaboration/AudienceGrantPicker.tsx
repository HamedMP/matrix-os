import { CollaborationGrantSchema, CollaborationScopeSchema, type CollaborationScope } from "@matrix-os/contracts";
import { useEffect, useState } from "react";
import { z } from "zod/v4";
import type { CollaborationApi } from "./ChatCollaboratorsDialog.js";

const MembersPageSchema = z.object({
  members: z.array(z.object({ actorId: z.string().min(1).max(160), role: z.string().min(1).max(80), joinedAt: z.iso.datetime() }).strict()).max(50),
  nextCursor: z.string().min(1).max(2_048).optional(),
}).strict();
const GrantsSchema = z.array(CollaborationGrantSchema).max(100);
const buttonClass = "rounded-lg border px-3 py-2 text-sm transition-colors hover:enabled:bg-[var(--bg-hover)] disabled:opacity-50";

type Member = z.infer<typeof MembersPageSchema>["members"][number];

export function AudienceGrantPicker({ api, scope, onRefresh }: {
  api: CollaborationApi;
  scope: CollaborationScope;
  onRefresh?: () => Promise<unknown>;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<z.infer<typeof GrantsSchema>>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [audience, setAudience] = useState("organization");
  const [preset, setPreset] = useState<"viewer" | "contributor">("viewer");
  const [revision, setRevision] = useState(scope.revision);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [retryToken, setRetryToken] = useState(0);
  const base = `/api/collaboration/scopes/${encodeURIComponent(scope.id)}`;
  const orgId = scope.organizationId;
  useEffect(() => {
    if (!orgId) { setLoading(false); setError(true); return; }
    let active = true;
    void Promise.all([
      api.get(`/api/organizations/${encodeURIComponent(orgId)}/members`),
      api.get(`${base}/grants`),
      api.get(base),
    ]).then(([memberPage, grantRows, scopeValue]) => {
      if (!active) return;
      const page = MembersPageSchema.parse(memberPage);
      const currentScope = CollaborationScopeSchema.parse(scopeValue);
      if (currentScope.id !== scope.id || currentScope.organizationId !== orgId || currentScope.role !== "owner") {
        throw new Error("Scope owner mismatch");
      }
      setRevision(currentScope.revision);
      setMembers(page.members.filter((member) => member.actorId !== scope.ownerId));
      setCursor(page.nextCursor ?? null);
      setGrants(GrantsSchema.parse(grantRows));
      setError(false);
    }).catch((failure: unknown) => {
      console.warn("[collaboration-access] audience load failed", failure instanceof Error ? failure.name : "UnknownError");
      if (active) setError(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [api, base, orgId, scope.ownerId, retryToken]);
  const loadMore = async () => {
    if (!orgId || !cursor || pending) return;
    setPending(true);
    try {
      const page = MembersPageSchema.parse(await api.get(`/api/organizations/${encodeURIComponent(orgId)}/members?cursor=${encodeURIComponent(cursor)}`));
      setMembers((current) => {
        const byActor = new Map(current.map((member) => [member.actorId, member]));
        for (const member of page.members) if (member.actorId !== scope.ownerId) byActor.set(member.actorId, member);
        return Array.from(byActor.values()).slice(0, 500);
      });
      setCursor(members.length + page.members.length >= 500 ? null : page.nextCursor ?? null);
      setError(false);
    } catch (failure: unknown) {
      console.warn("[collaboration-access] member page failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(false); }
  };
  const reloadGrants = async () => {
    const [nextScope, nextGrants] = await Promise.all([api.get(base), api.get(`${base}/grants`)]);
    setRevision(CollaborationScopeSchema.parse(nextScope).revision);
    setGrants(GrantsSchema.parse(nextGrants));
    await onRefresh?.();
  };
  const mutateGrant = async (grant: z.infer<typeof CollaborationGrantSchema>, nextPreset?: "viewer" | "contributor") => {
    if (pending || loading || error) return;
    setPending(true); setFeedback("");
    try {
      const path = `${base}/grants/${encodeURIComponent(grant.id)}`;
      if (nextPreset) {
        if (!api.patch) throw new Error("Grant editing unavailable");
        CollaborationGrantSchema.parse(await api.patch(path, {
          clientRequestId: crypto.randomUUID(), expectedRevision: revision,
          expectedGrantRevision: grant.revision, preset: nextPreset,
        }));
      } else {
        await api.delete(path, {
          clientRequestId: crypto.randomUUID(), expectedRevision: revision,
          expectedMemberRevision: grant.revision,
        });
      }
      await reloadGrants();
      setFeedback(nextPreset ? "Access preset updated." : "Access revoked.");
    } catch (failure: unknown) {
      console.warn("[collaboration-access] grant mutation failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(false); }
  };
  const create = async () => {
    if (!orgId || pending || loading || error) return;
    const selected = audience === "organization" ? { kind: "organization" as const }
      : members.some((member) => member.actorId === audience) ? { kind: "member" as const, actorId: audience } : null;
    if (!selected) { setError(true); return; }
    setPending(true); setFeedback("");
    try {
      const created = CollaborationGrantSchema.parse(await api.post(`${base}/grants`, {
        clientRequestId: crypto.randomUUID(), expectedRevision: revision, audience: selected, preset,
      }));
      await reloadGrants();
      setFeedback(created.audience.kind === "organization"
        ? "Organization access is pending until each member opens the share."
        : "Member access is pending until this member opens the share.");
      setError(false);
    } catch (failure: unknown) {
      console.warn("[collaboration-access] grant failed", failure instanceof Error ? failure.name : "UnknownError");
      setError(true);
    } finally { setPending(false); }
  };
  return <section aria-label="Share with organization" className="rounded-xl border p-4">
    <h3 className="font-medium">Share with your organization</h3>
    <p className="mt-1 text-xs">Current organization members only. Access starts when the recipient opens the share.</p>
    {loading ? <p role="status" className="mt-2 text-sm">Loading organization members…</p> : null}
    {error ? <div role="alert" className="mt-2 text-sm">Organization access is unavailable. Refresh and try again.
      <button type="button" className={`${buttonClass} ml-2`} onClick={() => { setLoading(true); setError(false); setRetryToken((value) => value + 1); }}>Retry</button>
    </div> : null}
    <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_9rem_auto]">
      <label className="grid gap-1 text-sm">Share with
        <select value={audience} disabled={loading || pending || error} onChange={(event) => setAudience(event.target.value)} className="min-w-0 rounded-lg border bg-transparent px-3 py-2">
          <option value="organization">Everyone in the organization</option>
          {members.map((member) => <option key={member.actorId} value={member.actorId}>{member.actorId}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Access preset
        <select value={preset} disabled={loading || pending || error} onChange={(event) => setPreset(event.target.value as "viewer" | "contributor")} className="rounded-lg border bg-transparent px-3 py-2">
          <option value="viewer">Viewer</option><option value="contributor">Contributor</option>
        </select>
      </label>
      <button type="button" className={`${buttonClass} self-end`} disabled={loading || pending || error} onClick={() => void create()}>Grant access</button>
    </div>
    {cursor ? <button type="button" className={`${buttonClass} mt-2`} disabled={pending} onClick={() => void loadMore()}>More members</button> : null}
    {grants.length ? <ul className="mt-3 space-y-2 text-sm">{grants.filter((grant) => grant.state === "active" || grant.state === "pending").map((grant) => <li key={grant.id} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <span className="min-w-0 flex-1 truncate">{grant.audience.kind === "organization" ? "Everyone in the organization" : grant.audience.actorId} · {grant.state}</span>
      <select aria-label={`Preset for ${grant.audience.kind === "organization" ? "organization" : grant.audience.actorId}`}
        value={grant.preset} disabled={pending || loading || error || !api.patch}
        onChange={(event) => void mutateGrant(grant, event.target.value as "viewer" | "contributor")}
        className="rounded-lg border bg-transparent px-2 py-1">
        <option value="viewer">Viewer</option><option value="contributor">Contributor</option>
      </select>
      <button type="button" className={buttonClass} disabled={pending || loading || error} onClick={() => void mutateGrant(grant)}>Revoke</button>
    </li>)}</ul> : null}
    {feedback ? <p role="status" className="mt-2 text-sm">{feedback}</p> : null}
  </section>;
}
