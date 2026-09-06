export interface CustomMcpPolicyTool {
  name: string;
  enabled: boolean;
  approval: "always_ask" | "allow";
}

/**
 * Rebase local policy choices onto the latest authoritative server revision.
 * Newly discovered tools keep their server defaults, and tools removed by a
 * concurrent discovery are omitted from the next write.
 */
export function rebaseCustomMcpPolicy<
  TTool extends CustomMcpPolicyTool,
  TServer extends { revision: number; enabled: boolean; tools: TTool[] },
>(authoritative: TServer, desired: TServer): TServer {
  const tools = authoritative.tools.map((tool) => {
    const local = desired.tools.find((candidate) => candidate.name === tool.name);
    return local ? { ...tool, enabled: local.enabled, approval: local.approval } : tool;
  }) as TTool[];
  return {
    ...authoritative,
    enabled: desired.enabled && tools.some((tool) => tool.enabled),
    tools,
  };
}
