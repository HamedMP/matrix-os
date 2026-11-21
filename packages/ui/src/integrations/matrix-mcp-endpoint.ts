/**
 * The one Matrix MCP URL that external clients use to reach every service the
 * owner connected in Matrix (spec 2691, "Use it anywhere"). Clients sign in
 * with Matrix OAuth for the hosted `/mcp` resource; service credentials stay in
 * the Matrix platform broker.
 */
export const DEFAULT_MATRIX_MCP_ENDPOINT = "https://app.matrix-os.com/mcp";

/**
 * Resolves the endpoint from a platform origin. Only an https origin on a
 * Matrix host is trusted; anything else (local dev, a VPS-local origin, a
 * malformed value) falls back to the production endpoint.
 */
export function matrixMcpEndpointUrl(platformOrigin?: string | null): string {
  if (!platformOrigin) return DEFAULT_MATRIX_MCP_ENDPOINT;
  try {
    const url = new URL(platformOrigin);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || (host !== "matrix-os.com" && !host.endsWith(".matrix-os.com"))) return DEFAULT_MATRIX_MCP_ENDPOINT;
    return `${url.origin}/mcp`;
  } catch (error: unknown) {
    if (error instanceof TypeError) return DEFAULT_MATRIX_MCP_ENDPOINT;
    throw error;
  }
}

export type MatrixMcpClientId = "claude-code" | "codex" | "cursor" | "stdio";

export interface MatrixMcpClientSetup {
  id: MatrixMcpClientId;
  label: string;
  /** What to paste: a shell command or a config snippet. */
  snippet: string;
  snippetLabel: string;
  /** One short sentence on how sign-in finishes. */
  hint: string;
}

export function matrixMcpClientSetups(endpoint: string): MatrixMcpClientSetup[] {
  return [
    {
      id: "claude-code",
      label: "Claude Code",
      snippet: `claude mcp add --transport http matrix ${endpoint}`,
      snippetLabel: "Terminal",
      hint: "Then run /mcp in Claude Code and sign in to Matrix.",
    },
    {
      id: "codex",
      label: "Codex",
      snippet: `codex mcp add matrix --url ${endpoint}\ncodex mcp login matrix`,
      snippetLabel: "Terminal",
      hint: "The login step opens Matrix in your browser to approve Codex.",
    },
    {
      id: "cursor",
      label: "Cursor",
      snippet: JSON.stringify({ mcpServers: { matrix: { url: endpoint } } }, null, 2),
      snippetLabel: "~/.cursor/mcp.json",
      hint: "Cursor asks you to sign in to Matrix the first time it connects.",
    },
    {
      id: "stdio",
      label: "Other clients",
      snippet: "matrix mcp login\nmatrix mcp bridge",
      snippetLabel: "Terminal",
      hint: "For clients that only run local (stdio) servers: add the command `matrix mcp bridge` as the server.",
    },
  ];
}
