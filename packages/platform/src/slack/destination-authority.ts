import type { SlackReceiptKey } from "./repository.js";
import type { SlackAppRouteOptions } from "./routes.js";

/** Shared by context reads and publication. The scope resolver rechecks live resource grants and output audience. */
export async function authorizeSlackDestination(options: SlackAppRouteOptions, key: SlackReceiptKey, ownerId: string, publication?: { textDigest: string }) {
  const destination = await options.repository.getReplyDestination(key);
  if (!destination || destination.ownerId !== ownerId) return null;
  const pinned = destination;
  async function currentMetadata() {
    if (!await options.isCurrentMember({ actorId: pinned.actorId, organizationId: pinned.organizationId })) return null;
    // Read local fences after any remote membership check, including receipt expiry.
    const current = await options.repository.getReplyDestination(key);
    if (!current || JSON.stringify(current) !== JSON.stringify(pinned)) return null;
    const installed = await options.repository.getInstallation(key.appId, key.teamId);
    if (!installed || installed.state !== "active" || installed.organizationId !== current.organizationId || installed.generation !== current.installationGeneration) return null;
    const link = await options.repository.getLink(key.appId, key.teamId, current.slackUserId);
    if (!link || link.actorId !== current.actorId || link.organizationId !== current.organizationId) return null;
    if (current.scopeId) {
      const binding = await options.repository.getChannelBinding(key.appId, key.teamId, current.channelId);
      if (!binding || !binding.approvedOutput || binding.scopeId !== current.scopeId || binding.organizationId !== current.organizationId) return null;
    }
    return { destination: current, installed };
  }
  const metadata = await currentMetadata();
  if (!metadata || !options.authorizeReply || !await options.authorizeReply({ installation: metadata.installed, destination: metadata.destination, ownerId, ...(publication ? { publication } : {}) })) return null;
  // Owner authorization can wait on a home RPC. Unlink, uninstall or rebinding during
  // that wait must invalidate the stale response without issuing another home RPC.
  return currentMetadata();
}
