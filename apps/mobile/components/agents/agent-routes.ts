/** The Agents tab's first screen: the list. */
export const AGENTS_LIST_ROUTE = "/agents";

/** An agent's own chat, `/agents/<agentId>`. Built on each call, as a router takes it. */
export function agentChatRoute(agentId: string) {
  return { pathname: "/agents/[agentId]", params: { agentId } } as const;
}
