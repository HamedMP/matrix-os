import { writeManifest } from "./manifest.js";
import type { Manifest } from "./types.js";
import type { HomeMirrorState } from "./home-mirror-state.js";

export class MirrorPublicationChanged extends Error {}

/** Admit capacity first, then check owner bytes after upload and immediately before metadata CAS.
 * Filesystem observation and DB publication are not a cross-resource transaction.
 */
export async function publishMirrorManifest(options: {
  lockedStore: Parameters<typeof writeManifest>[0];
  scope: Parameters<typeof writeManifest>[1];
  next: Manifest;
  version: number;
  changes: ReadonlyArray<{ path: string; hash: string }>;
  state: HomeMirrorState;
  matchesLocal: (path: string, hash: string) => Promise<boolean>;
  changed: () => void;
}): Promise<boolean> {
  await options.state.preflightRemember(options.changes);
  try {
    await writeManifest(options.lockedStore, options.scope, options.next, options.version, async () => {
      for (const file of options.changes) if (!await options.matchesLocal(file.path, file.hash)) throw new MirrorPublicationChanged();
    });
    return true;
  } catch (error: unknown) {
    if (!(error instanceof MirrorPublicationChanged)) throw error;
    options.changed();
    return false;
  }
}
