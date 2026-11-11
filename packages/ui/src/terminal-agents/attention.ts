/** Herdr's status words, as the gateway reports them per terminal tab. */
export type TerminalAgentWord = "idle" | "working" | "done" | "blocked" | "error";

export interface TerminalRefLike { workspaceId: string; tabId: string }

export interface TerminalTabFacts {
  ref: TerminalRefLike;
  name: string;
  cwd: string;
  projectId?: string;
  state: "live" | "finished";
  exitCode?: number | null;
  agentStatus?: TerminalAgentWord;
  statusMessage?: string;
  statusAt?: string;
}

export type TerminalAttentionKind = "blocked" | "error" | "done";

export interface TerminalAttention {
  key: string;
  kind: TerminalAttentionKind;
  ref: TerminalRefLike;
  name: string;
  message?: string;
}

export function terminalFactsKey(ref: TerminalRefLike): string {
  return `${ref.workspaceId}:${ref.tabId}`;
}

// Herdr's order: blocked > done > working > idle. An error needs the person like a block.
const URGENCY: Record<TerminalAgentWord, number> = { blocked: 4, error: 4, done: 3, working: 2, idle: 1 };

/** The most urgent status among a project's or tab's agents. */
export function rollUpTerminalStatus(words: ReadonlyArray<TerminalAgentWord | undefined>): TerminalAgentWord | undefined {
  let best: TerminalAgentWord | undefined;
  for (const word of words) {
    if (word && (!best || URGENCY[word] > URGENCY[best])) best = word;
  }
  return best;
}

/** Matrix's sidebar vocabulary for a Herdr status word. */
export function terminalVisualStatus(word: TerminalAgentWord | undefined): "running" | "waiting" | "finished" | "idle" | undefined {
  switch (word) {
    case "working": return "running";
    case "blocked":
    case "error": return "waiting";
    case "done": return "finished";
    case "idle": return "idle";
    default: return undefined;
  }
}

/**
 * What deserves the person's attention when facts change: a blocked or errored
 * agent always, and a finished one only while they aren't looking at it.
 * `seen` lists the tabs on screen now.
 */
export function terminalAttentionChanges(
  previous: ReadonlyMap<string, TerminalTabFacts>,
  next: ReadonlyMap<string, TerminalTabFacts>,
  seen: ReadonlySet<string>,
): TerminalAttention[] {
  const changes: TerminalAttention[] = [];
  for (const [key, tab] of next) {
    const before = previous.get(key);
    if (!before || tab.state !== "live" || before.agentStatus === tab.agentStatus) continue;
    const word = tab.agentStatus;
    if (word !== "blocked" && word !== "error" && word !== "done") continue;
    if (word === "done" && seen.has(key)) continue;
    changes.push({
      key, kind: word, ref: tab.ref, name: tab.name,
      ...(tab.statusMessage ? { message: tab.statusMessage } : {}),
    });
  }
  return changes;
}

/** Agents in Herdr's navigation order: needs you, done, working, idle; then by name. */
export function orderTerminalAgents(facts: Iterable<TerminalTabFacts>): TerminalTabFacts[] {
  return [...facts]
    .filter((tab) => tab.state === "live" && tab.agentStatus)
    .sort((left, right) => (URGENCY[right.agentStatus!] - URGENCY[left.agentStatus!]) || left.name.localeCompare(right.name));
}
