import { getGatewayUrl } from "./gateway";
import type { ShellSnapshotScope } from "./shell-snapshot-cache";

/** Match the validated route used by the transport, including an explicit runtime slot.
 * Keep the encoded owner prefix so logout can remove all of that viewer's runtimes.
 * Root/invalid runtime queries follow gateway resolution instead of creating new scopes.
 */
export function createShellChatNavigationScope(
  viewer: Pick<ShellSnapshotScope, "userId"> | null,
  sessionId: string | null | undefined,
): string | undefined {
  if (!viewer || !sessionId) return undefined;
  return `${encodeURIComponent(viewer.userId)}/runtime/${encodeURIComponent(getGatewayUrl())}`;
}
