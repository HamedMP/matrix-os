import type { Kysely } from "kysely";
import { requireRequestPrincipal } from "../domains/identity/request-principal.js";
import type { SyncRouteDeps } from "./routes.js";
import { createR2Client, type R2Client, type R2ClientConfig } from "./r2-client.js";
import { createPlatformR2Client } from "./platform-r2-client.js";
import { createManifestDb, createKyselySharingDb } from "./db-impl.js";
import { createPeerRegistry, type PeerRegistry } from "./ws-events.js";
import { createSharingService, type SharingService } from "./sharing.js";
import { sanitizePeerId } from "./peer-id.js";
import { deriveGatewaySyncUserSeeds, ensureSyncUser, migrateSyncTables, type SyncDatabase } from "./sharing-db.js";
import { resolveSyncScope } from "./runtime-scope.js";

export async function initializeSyncInfrastructure(kyselyInstance: Kysely<SyncDatabase> | null) {
  const internalPlatformUrl = process.env.PLATFORM_INTERNAL_URL;
  const internalPlatformToken = process.env.UPGRADE_TOKEN;
  const internalSyncRuntimeToken = process.env.MATRIX_SYNC_RUNTIME_TOKEN;
  const internalHandle = process.env.MATRIX_HANDLE;
  // 066: Sync infrastructure (R2/S3 + ManifestDb + PeerRegistry + Sharing)
  let syncR2: R2Client | null = null;
  let syncPeerRegistry: PeerRegistry | null = null;
  let syncSharing: SharingService | null = null;
  let syncDeps: SyncRouteDeps | null = null;

  const s3Endpoint = process.env.S3_ENDPOINT ?? process.env.R2_ENDPOINT;
  const s3AccessKey = process.env.S3_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID;
  const s3SecretKey = process.env.S3_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY;
  const s3Bucket = process.env.S3_BUCKET ?? process.env.R2_BUCKET ?? "matrixos-sync";
  const s3ForcePathStyle = process.env.S3_FORCE_PATH_STYLE === "true";


  if (((s3AccessKey && s3SecretKey) || (internalPlatformUrl && internalPlatformToken && internalHandle)) && kyselyInstance) {
    try {
      if (s3AccessKey && s3SecretKey) {
        const r2Config: R2ClientConfig = {
          accessKeyId: s3AccessKey,
          secretAccessKey: s3SecretKey,
          bucket: s3Bucket,
          endpoint: s3Endpoint,
          publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.R2_PUBLIC_ENDPOINT,
          accountId: process.env.R2_ACCOUNT_ID,
          forcePathStyle: s3ForcePathStyle,
        };
        syncR2 = await createR2Client(r2Config);
      } else {
        if (internalSyncRuntimeToken && (!process.env.MATRIX_MACHINE_ID || !process.env.MATRIX_RUNTIME_SLOT)) {
          throw new Error("Scoped sync runtime identity is incomplete");
        }
        syncR2 = createPlatformR2Client({
          baseUrl: internalPlatformUrl!,
          handle: internalHandle!,
          token: internalSyncRuntimeToken ?? internalPlatformToken!,
          ...(internalSyncRuntimeToken
            && process.env.MATRIX_MACHINE_ID
            && process.env.MATRIX_RUNTIME_SLOT
            ? {
                machineId: process.env.MATRIX_MACHINE_ID,
                runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
              }
            : {}),
        });
      }

      await migrateSyncTables(kyselyInstance as Kysely<SyncDatabase>);
      for (const seed of deriveGatewaySyncUserSeeds()) {
        await ensureSyncUser(kyselyInstance as Kysely<SyncDatabase>, seed);
      }

      const manifestDb = createManifestDb(kyselyInstance as Kysely<SyncDatabase>);
      syncPeerRegistry = createPeerRegistry();
      const sharingDb = createKyselySharingDb(kyselyInstance as Kysely<SyncDatabase>);
      syncSharing = createSharingService({ db: sharingDb, peerRegistry: syncPeerRegistry });

      syncDeps = {
        r2: syncR2,
        db: manifestDb,
        peerRegistry: syncPeerRegistry,
        sharing: syncSharing,
        // Resolve userId per request through the canonical principal seam so
        // sync storage keys follow the same source precedence as other
        // protected owner-scoped routes.
        getScope: (c) => resolveSyncScope({
          ownerId: requireRequestPrincipal(c).userId,
          runtimeSlot: process.env.MATRIX_RUNTIME_SLOT,
        }),
        getPeerId: (c) => sanitizePeerId(c.req.header("X-Peer-Id")),
      };

      console.log("[sync] Sync API initialized (storage:", s3AccessKey && s3SecretKey ? (s3Endpoint ?? "R2") : "platform-internal", ")");
    } catch (err) {
      console.error("[sync] Failed to initialize sync:", (err as Error).message);
      syncR2 = null;
      syncPeerRegistry = null;
      syncSharing = null;
      syncDeps = null;
    }
  } else {
    console.log("[sync] No trusted sync storage configured, sync API disabled");
  }

  return { syncR2, syncPeerRegistry, syncSharing, syncDeps };
}
