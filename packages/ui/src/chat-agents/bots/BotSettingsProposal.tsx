import { useEffect, useState } from "react";
import { BotSavedSettingsPatchSchema, type CanonicalChatDetailResponse, type ChatAgent, type BotSavedSettingsPatch } from "@matrix-os/contracts";
import { Button } from "../../Button.js";
import type { ChatAgentClient } from "../client.js";

export interface SavedBotProposal {
  agentId: string;
  chatId: string;
  runId: string;
  proposalId: string;
  revision: number;
  patch: BotSavedSettingsPatch;
}

export function savedBotProposals(detail: CanonicalChatDetailResponse, chatId: string, agentId: string): SavedBotProposal[] {
  const { chat } = detail.record;
  if (chat.id !== chatId || chat.ownerScope.type !== "personal" || chat.lifecycle !== "active" || chat.collaboration || detail.record.projectId) return [];
  const ownerId = chat.ownerScope.ownerId;
  const completed = new Set(detail.runs.filter(run => run.chatId === chatId && run.driverKind === "matrix_bot"
    && run.status === "completed" && run.instanceId === "matrix_bot_default").map(run => run.id));
  return detail.activities.flatMap(activity => {
    if (activity.type !== "bot.draft.proposed" || activity.chatId !== chatId || activity.sessionId !== agentId || !completed.has(activity.runId)) return [];
    const run = detail.runs.find(candidate => candidate.id === activity.runId);
    const turn = detail.turns.find(candidate => candidate.chatId === chatId && candidate.id === run?.turnId);
    if (!detail.messages.some(message => message.id === turn?.inputMessageId && message.chatId === chatId && message.state === "committed"
      && message.role === "user" && message.actorId === ownerId)) return [];
    const patch = BotSavedSettingsPatchSchema.safeParse(activity.patch);
    if (!patch.success || activity.baseDraftRevision < 1) return [];
    return [{ agentId, chatId, runId: activity.runId, proposalId: activity.proposalId, revision: activity.baseDraftRevision, patch: patch.data }];
  });
}

/** Fetch negotiated structured output only after the gateway published a proposal in this direct Chat. */
export function useSavedBotProposal(client: ChatAgentClient | undefined, chatId: string | undefined, agentId: string | null, runId?: string) {
  const [read, setRead] = useState<{ client: ChatAgentClient; value: SavedBotProposal } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    setError(false);
    if (!client?.setupChat || !chatId || !agentId || !runId) return;
    const source = client.setupChat;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 60_000;
    const load = async () => {
      try {
        const detail = await source.detail(chatId);
        if (!current) return;
        const proposal = savedBotProposals(detail, chatId, agentId).find(row => row.runId === runId);
        if (proposal) { setRead({ client, value: proposal }); return; }
        const run = detail.runs.find(row => row.id === runId);
        if (run && !["completed", "failed", "aborted"].includes(run.status)) {
          if (Date.now() < deadline) timer = setTimeout(() => { void load(); }, 1500);
          else setError(true);
        }
      } catch (failure: unknown) {
        if (!current) return;
        console.warn("[bots] Suggested settings unavailable:", failure instanceof Error ? failure.name : "UnknownError");
        setError(true);
      }
    };
    void load();
    return () => { current = false; clearTimeout(timer); };
  }, [client, chatId, agentId, runId, attempt]);
  const proposal = read?.client === client && read?.value.chatId === chatId && read?.value.agentId === agentId && read?.value.runId === runId
    ? read?.value : undefined;
  return { proposal, error: Boolean(runId && error), retry: () => retry(value => value + 1) };
}

const labels = { name: "Name", description: "Description", instructions: "Instructions" } as const;

export function BotSettingsProposal({ proposal, agent, save }: { proposal: SavedBotProposal; agent: ChatAgent; save(): Promise<void> }) {
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  if (proposal.agentId !== agent.id || agent.archived) return null;
  const matches = (Object.keys(proposal.patch) as (keyof BotSavedSettingsPatch)[]).every(key => agent[key] === proposal.patch[key]);
  if (saved || agent.revision > proposal.revision && matches) return <p role="status" className="text-sm">Agent settings match this suggestion.</p>;
  if (agent.revision !== proposal.revision) return <p role="status" className="text-sm">Agent settings have changed since this suggestion.</p>;
  return <section aria-label="Suggested Agent changes" className="grid min-w-0 gap-2 rounded-lg border p-3 text-sm">
    <p className="font-medium">Suggested changes</p>
    <dl className="grid gap-2">{(Object.keys(proposal.patch) as (keyof BotSavedSettingsPatch)[]).map(key =>
      <div key={key}><dt className="font-medium">{labels[key]}</dt><dd className="whitespace-pre-wrap [overflow-wrap:anywhere]">{proposal.patch[key] || "(empty)"}</dd></div>)}</dl>
    <Button size="sm" className="justify-self-start" disabled={pending || matches} onClick={async () => {
      if (pending) return;
      setPending(true); setError("");
      try { await save(); setSaved(true); }
      catch (failure: unknown) {
        console.warn("[bots] Suggested changes could not be saved:", failure instanceof Error ? failure.name : "UnknownError");
        setError("Could not confirm these changes. Reopen this Chat to check the saved settings.");
      } finally { setPending(false); }
    }}>{pending ? "Saving…" : "Save changes"}</Button>
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
