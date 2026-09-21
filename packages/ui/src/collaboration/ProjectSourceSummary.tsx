import type { CollaborationProjectAccessReadiness, CollaborationProjectGitSetup } from "@matrix-os/contracts";

/** Owner-host Git setup and the exact Chat roots in the signed project inventory. */
export function ProjectSourceSummary({ gitSetup, chatRoots }: {
  gitSetup?: CollaborationProjectGitSetup;
  chatRoots: CollaborationProjectAccessReadiness["chatRoots"];
}) {
  return <section aria-label="Project source" className="rounded-xl border p-4 text-sm">
    <h3 className="font-medium">Project Chat roots and Git</h3>
    {chatRoots.length ? <ul className="mt-2 space-y-2">{chatRoots.map((chat) => <li key={chat.chatId} className="rounded-lg border p-2">
      <span className="font-medium">{chat.chatId}</span>
      <p>{chat.executionRoot?.kind === "worktree" ? `Chat worktree ${chat.executionRoot.worktreeId}` : "Project root"}</p>
      {chat.branch ? <p>Branch: {chat.branch}</p> : null}
      {chat.dirty ? <p>Uncommitted changes</p> : null}
      {chat.readiness === "blocked" ? <p>Chat root unavailable</p> : null}
    </li>)}</ul> : <p className="mt-2">No project Chats yet.</p>}
    {gitSetup ? <>
      <p className="mt-2">{gitSetup.identity.status === "ready"
        ? `Commits use ${gitSetup.identity.label ?? "the owner's Git identity"}.`
        : gitSetup.identity.status === "missing" ? "Owner Git identity is missing." : "Owner Git identity is unavailable."}</p>
      <p>{gitSetup.forgeCredential.status === "ready" ? "GitHub access is ready."
        : gitSetup.forgeCredential.status === "missing" ? "GitHub access is missing." : "GitHub access is unavailable."}</p>
    </> : null}
  </section>;
}
