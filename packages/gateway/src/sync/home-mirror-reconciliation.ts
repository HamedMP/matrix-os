import { createHash } from "node:crypto";
import type { ManifestEntry } from "./types.js";
import type { HomeMirrorState } from "./home-mirror-state.js";

/** Three-way decisions share one baseline; neither local nor remote wins an ambiguous conflict. */
export class HomeMirrorReconciliation {
  constructor(
    private readonly state: HomeMirrorState,
    private readonly readRemote: (path: string, entry: ManifestEntry) => Promise<Buffer>,
  ) {}

  async shouldPull(path: string, localHash: string, remote: ManifestEntry): Promise<boolean> {
    if (localHash === remote.hash) {
      await this.state.remember(path, remote.hash);
      return false;
    }
    const baseline = this.state.hash(path);
    if (baseline === localHash) return true;
    if (baseline !== remote.hash) {
      await this.state.preserve(path, localHash, remote.hash, await this.readRemote(path, remote));
    }
    return false;
  }

  async preserveDeletion(path: string, remote: ManifestEntry): Promise<void> {
    const absentHash = `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("hex")}`;
    await this.state.preserve(path, absentHash, remote.hash, await this.readRemote(path, remote), true);
  }

  /** Called inside the manifest advisory lock, against its current accepted revision. */
  async canPublish(path: string, localHash: string, current: ManifestEntry | undefined): Promise<boolean> {
    if (current && !current.deleted && current.hash === localHash) {
      await this.state.remember(path, localHash);
      return true;
    }
    if (this.state.blocked(path)) return false;
    if (current && !current.deleted && current.hash !== this.state.hash(path)) {
      await this.state.preserve(path, localHash, current.hash, await this.readRemote(path, current));
      return false;
    }
    // A tombstone is remote data too; never silently resurrect it.
    return !current?.deleted;
  }
}
