import type { CollaborativeAppDirectoryItem } from "@matrix-os/contracts";

export function sharedAppWindowPath(target: Pick<CollaborativeAppDirectoryItem, "scopeId">): string {
  return `__shared-app__:${target.scopeId}`;
}

export function sharedAppWindowTitle(target: Pick<CollaborativeAppDirectoryItem, "appId" | "owner">): string {
  const app = target.appId.replaceAll(/[-_]+/g, " ").replace(/^./, (value) => value.toUpperCase());
  return `${app} shared by ${target.owner.displayName}`;
}

export function sharedAppDeepLink(target: Pick<CollaborativeAppDirectoryItem, "scopeId" | "buildId" | "shareRevision">): string {
  const query = new URLSearchParams({
    expectedBuildId: target.buildId,
    expectedShareRevision: target.shareRevision,
  });
  return `/shared/app/${encodeURIComponent(target.scopeId)}?${query.toString()}`;
}
