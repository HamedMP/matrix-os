// Pulled out of VocalPanel.tsx as a dependency-free module so it's testable
// without VocalPanel's WS/mic session, react-query, and hook dependencies.

// Finds the most recent role:"system" message in a delegation window to
// narrate as a create_app build's error. Canonical approval cards are also
// role "system" (canonical-chat-client.ts's projectCanonicalMessages), so an
// unrelated pending/resolved approval in the window must be skipped rather
// than narrated as the build's error. metadata.canonicalApproval is the same
// marker CanonicalApprovalMessage keys off to render controls vs. a plain
// notice.
export function findRecentSystemErrorMessage(
  messages: readonly { role: string; content: string; metadata?: Record<string, unknown> }[],
  startIdx: number,
): string | undefined {
  const start = Math.max(0, startIdx);
  for (let i = messages.length - 1; i >= start; i--) {
    const m = messages[i];
    if (m.role === "system" && m.metadata?.canonicalApproval === undefined) {
      return m.content.slice(0, 500);
    }
  }
  return undefined;
}
