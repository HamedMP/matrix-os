import { useEffect, useRef, useState } from "react";
import { z } from "zod/v4";


import { ChatShareDialog } from "./ChatShareDialog.js";
import { ChatCollaboratorsDialog, type CollaborationApi } from "../collaboration/ChatCollaboratorsDialog.js";
import { ShareChoiceDialog } from "../collaboration/ShareChoiceDialog.js";
import { CollaborationMemberSchema, CollaborationScopePreflightResponseSchema, CollaborationScopeSchema } from "@matrix-os/contracts";

const PreviewSchema = z.object({
  title: z.string().max(240), revision: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(96_000) })).max(200),
});
const SharesSchema = z.object({ shares: z.array(z.object({ id: z.uuid(), expiresAt: z.string().max(100) })).max(10) });
const CreatedSchema = z.object({ id: z.uuid(), token: z.string().regex(/^[a-f0-9]{64}$/) });

export function ChatSharingButton({ api, collaborationApi, runtimeId, chatId, copyText, handle, runtimeSlot, platformHost }: {
  api: { baseUrl: string; get(path: string): Promise<unknown>; post(path: string, body: unknown): Promise<unknown>; delete(path: string): Promise<unknown> };
  collaborationApi?: CollaborationApi;
  runtimeId?: string | null;
  handle: string | null;
  runtimeSlot: string;
  platformHost: string;
  chatId: string;
  copyText: (value: string) => Promise<void>;
}) {
  const [preview, setPreview] = useState<z.infer<typeof PreviewSchema> | null>(null);
  const [existing, setExisting] = useState<z.infer<typeof SharesSchema>["shares"]>([]);
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [surface, setSurface] = useState<"choice" | "snapshot" | "collaborators" | null>(null);
  const [scope, setScope] = useState<z.infer<typeof CollaborationScopeSchema> | null>(null);
  const [members, setMembers] = useState<z.infer<typeof CollaborationMemberSchema>[]>([]);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const path = `/api/chats/${encodeURIComponent(chatId)}/shares`;
  const openSnapshot = async () => {
    setPending(true); setError(false); setNotice("");
    try {
      const [snapshot, links] = await Promise.all([api.get(`${path}/preview`), api.get(path)]);
      if (!alive.current) return;
      setPreview(PreviewSchema.parse(snapshot));
      setExisting(SharesSchema.parse(links).shares);
      setSurface("snapshot");
    } catch (failure: unknown) {
      console.warn("[chat-share] preview failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally { if (alive.current) setPending(false); }
  };
  const refreshCollaborators = async (scopeId: string) => {
    if (!collaborationApi) throw new Error("CollaborationUnavailable");
    const [nextScope, result] = await Promise.all([
      collaborationApi.get(`/api/collaboration/scopes/${scopeId}`),
      collaborationApi.get(`/api/collaboration/scopes/${scopeId}/members`),
    ]);
    const parsedScope = CollaborationScopeSchema.parse(nextScope);
    const parsedMembers = z.object({ members: z.array(CollaborationMemberSchema).max(8) }).parse(result).members;
    if (alive.current) { setScope(parsedScope); setMembers(parsedMembers); }
    return { scope: parsedScope, members: parsedMembers };
  };
  const openCollaborators = async () => {
    if (!collaborationApi || !runtimeId) return;
    setPending(true); setError(false); setNotice("");
    try {
      const preflight = CollaborationScopePreflightResponseSchema.parse(await collaborationApi.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes/preflight`,
        { kind: "chat", resourceId: chatId },
      ));
      if (!preflight.eligible || !preflight.confirmationToken) throw new Error("ChatActivityMustSettle");
      const created = CollaborationScopeSchema.parse(await collaborationApi.post(
        `/api/collaboration/runtimes/${runtimeId}/scopes`,
        {
          kind: "chat",
          resourceId: chatId,
          clientRequestId: crypto.randomUUID(),
          expectedRevision: preflight.resourceRevision,
          confirmationToken: preflight.confirmationToken,
        },
      ));
      await refreshCollaborators(created.id);
      if (alive.current) setSurface("collaborators");
    } catch (failure: unknown) {
      console.warn("[chat-collaboration] setup failed", failure instanceof Error ? failure.name : "UnknownError");
      if (alive.current) setError(true);
    } finally { if (alive.current) setPending(false); }
  };
  const close = () => { setSurface(null); setPreview(null); setScope(null); };
  return <div className="relative inline-flex shrink-0 items-center gap-2 text-xs">
    {error ? <span role="alert" className="absolute right-0 top-full z-50 mt-2 w-64 rounded-lg border bg-[var(--bg-surface,var(--background))] p-3 shadow-lg">Sharing unavailable. Try again.</span> : null}
    <button type="button" disabled={pending} aria-expanded={surface !== null} onClick={() => surface ? close() : setSurface("choice")}
      className="rounded-lg px-3 py-1.5 hover:bg-[var(--bg-hover)] disabled:opacity-50">{pending ? "Loading share…" : "Share"}</button>
    {surface === "choice" ? <ShareChoiceDialog collaborationAvailable={Boolean(collaborationApi && runtimeId)} pending={pending}
      onClose={close} onSnapshot={() => void openSnapshot()} onCollaborate={() => void openCollaborators()} /> : null}
    {surface === "snapshot" && preview ? <ChatShareDialog key={`${preview.fingerprint}:${preview.revision}`} notice={notice} title={preview.title} messages={preview.messages} existing={existing} copyText={copyText}
      onClose={close} revoke={async (id) => { await api.delete(`${path}/${encodeURIComponent(id)}`); }}
      createLink={async () => {
        const refresh = (latest: z.infer<typeof PreviewSchema>) => {
          if (alive.current) {
            setNotice("This Chat changed. Review the updated preview and confirm again.");
            setPreview(latest);
          }
          return null;
        };
        const latest = PreviewSchema.parse(await api.get(`${path}/preview`));
        if (!alive.current) return null;
        if (latest.fingerprint !== preview.fingerprint) return refresh(latest);
        let created: z.infer<typeof CreatedSchema>;
        try {
          created = CreatedSchema.parse(await api.post(path, { revision: latest.revision, fingerprint: latest.fingerprint, confirmed: true }));
        } catch (failure: unknown) {
          // A reply may commit between the preflight and the atomic create.
          const current = PreviewSchema.parse(await api.get(`${path}/preview`));
          if (current.fingerprint !== latest.fingerprint || current.revision !== latest.revision) return refresh(current);
          throw failure;
        }
        const url = handle && platformHost
          ? new URL(`/shared/chat/${encodeURIComponent(handle)}/${encodeURIComponent(runtimeSlot)}/${created.token}`, platformHost).href
          : new URL(`/api/share/chats/${created.token}`, api.baseUrl).href;
        return { id: created.id, url };
      }} /> : null}
    {surface === "collaborators" && scope && collaborationApi ? <ChatCollaboratorsDialog api={collaborationApi}
      scope={scope} members={members} onClose={close} onRefresh={() => refreshCollaborators(scope.id)} /> : null}
  </div>;
}
