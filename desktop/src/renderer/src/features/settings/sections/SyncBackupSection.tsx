import {
  SyncBackupView,
  type SyncBackupTransport,
} from "@matrix-os/ui";
import "@matrix-os/ui/sync-backup.css";
import { invoke } from "@renderer/lib/operator";

const desktopSyncTransport = {
  localFolderSync: true,
  getSnapshot: () => invoke("sync:get-snapshot", {}),
  reauthorize: () => invoke("sync:reauthorize", {}),
  chooseFolder: (suggestedName?: string) => invoke(
    "sync:choose-folder",
    suggestedName ? { suggestedName } : {},
  ),
  enable: (request) => invoke("sync:enable", request),
  addMapping: (request) => invoke("sync:add-mapping", request),
  pauseMapping: (mappingId) => invoke("sync:pause-mapping", { mappingId }),
  resumeMapping: (mappingId) => invoke("sync:resume-mapping", { mappingId }),
  removeMapping: (mappingId) => invoke("sync:remove-mapping", { mappingId }),
  rescan: (mappingId) => invoke("sync:rescan", mappingId ? { mappingId } : {}),
  setEnabled: (enabled) => invoke("sync:set-enabled", { enabled }),
} satisfies SyncBackupTransport;

export default function SyncBackupSection() {
  return <SyncBackupView transport={desktopSyncTransport} />;
}
