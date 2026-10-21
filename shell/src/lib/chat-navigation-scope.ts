import type { ShellSnapshotScope } from "./shell-snapshot-cache";

/** Match the mount-captured validated transport route, including an explicit runtime slot.
 * Keep the encoded owner prefix so logout can remove all of that viewer's runtimes.
 * Root/invalid runtime queries follow gateway resolution instead of creating new scopes.
 */
export function createShellChatNavigationScope(
  viewer: Pick<ShellSnapshotScope, "userId"> | null,
  sessionId: string | null | undefined,
  gatewayUrl: string,
): string | undefined {
  if (!viewer || !sessionId) return undefined;
  return `${encodeURIComponent(viewer.userId)}/runtime/${encodeURIComponent(gatewayUrl)}`;
}
