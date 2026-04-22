// Maps between a daemon's local sync-root-relative path and the gateway's
// remote path (which is namespaced by the user's chosen gateway folder).
//
// `gatewayFolder = ""` means "full mirror": local rel == remote rel, and
// every event is in-scope. A non-empty folder like "audit" means the daemon
// only cares about the `audit/` subtree of the gateway, and local files are
// uploaded with that prefix.
export interface RemotePrefixMapper {
  toRemote(localRel: string): string;
  toLocal(remotePath: string): string | null;
}

export function createRemotePrefixMapper(gatewayFolder: string): RemotePrefixMapper {
  const folder = gatewayFolder.replace(/^\/+|\/+$/g, "");

  if (folder === "") {
    return {
      toRemote: (localRel) => localRel,
      toLocal: (remote) => remote,
    };
  }

  const prefix = `${folder}/`;
  return {
    toRemote: (localRel) => `${folder}/${localRel}`,
    toLocal: (remote) => {
      if (!remote.startsWith(prefix)) return null;
      return remote.slice(prefix.length);
    },
  };
}
