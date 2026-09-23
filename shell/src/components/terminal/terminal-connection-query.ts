interface TerminalConnectionQueryInput {
  terminalRef: { workspaceId: string; tabId: string };
  fromSeq: number;
  mobile: boolean;
  lease?: "exclusive" | "observe" | null;
  size?: { cols: number; rows: number } | null;
}

/** Keep Terminal WebSocket capability requests together as the protocol grows. */
export function buildTerminalConnectionQuery(input: TerminalConnectionQueryInput) {
  return {
    workspaceId: input.terminalRef.workspaceId,
    tabId: input.terminalRef.tabId,
    fromSeq: String(input.fromSeq),
    client: input.mobile ? "mobile" : "browser",
    inputCapability: "binary-input-v1",
    scrollCapability: "native-scroll-v1",
    ...(input.lease ? { lease: input.lease } : {}),
    ...(input.size ? { cols: String(input.size.cols), rows: String(input.size.rows) } : {}),
  };
}
