import { join } from "node:path";
import { z } from "zod/v4";

import type { AppRegistry } from "../app-db-registry.js";
import { BuildOrchestrator } from "../app-runtime/build-orchestrator.js";
import type { ImmutableCollaborativeBuildStore } from "../app-runtime/build-cache.js";
import { resolveAppBySlug } from "../app-runtime/app-index.js";
import { appRegistryIncarnation } from "./app-incarnation.js";
import { createCollaborativeAppBuildIdentity } from "./collaborative-app-identity.js";
import type { CollaborativeAppReadinessRepository } from "./collaborative-app-readiness-repository.js";
import type { CollaborationResourceCatalog } from "./resource-catalog.js";
import type { CurrentCollaborativeAppBuild } from "./collaborative-app-readiness-routes.js";

export class CollaborativeAppBuildResolutionError extends Error {
  constructor() {
    super("Collaborative app build is unavailable");
    this.name = "CollaborativeAppBuildResolutionError";
  }
}

const JsonDocumentSchema = z.json();
function jsonDocument(value: unknown): z.infer<typeof JsonDocumentSchema> {
  return JsonDocumentSchema.parse(JSON.parse(JSON.stringify(value)));
}

export class CollaborativeAppBuildResolver {
  private readonly build: BuildOrchestrator;

  constructor(private readonly options: {
    homePath: string;
    ownerId: string;
    appRegistry: Pick<AppRegistry, "get">;
    catalog: Pick<CollaborationResourceCatalog, "getLiveByPath" | "register">;
    readiness: Pick<CollaborativeAppReadinessRepository, "invalidateDriftedBuilds">;
    store: ImmutableCollaborativeBuildStore;
    build?: BuildOrchestrator;
  }) {
    this.build = options.build ?? new BuildOrchestrator({ concurrency: 1 });
  }

  async resolve(
    ownerId: string,
    appId: string,
    options: { ensureCatalog: boolean },
  ): Promise<CurrentCollaborativeAppBuild | null> {
    if (ownerId !== this.options.ownerId) return null;
    const registration = await this.options.appRegistry.get(appId);
    if (!registration || registration.slug !== appId) return null;
    const incarnation = appRegistryIncarnation(registration);
    let catalog = await this.options.catalog.getLiveByPath({
      ownerId,
      projectId: null,
      kind: "app",
      path: appId,
    });
    if (!catalog && options.ensureCatalog) {
      catalog = await this.options.catalog.register({
        ownerId,
        projectId: null,
        kind: "app",
        path: appId,
        incarnation,
      });
    }
    if (!catalog || catalog.incarnation !== incarnation) return null;

    const resolved = await resolveAppBySlug(join(this.options.homePath, "apps"), appId);
    if (!resolved.ok) return null;
    const identity = (assetDigest: string, manifest: typeof resolved.entry.manifest) => {
      const declaration = manifest.collaboration;
      return createCollaborativeAppBuildIdentity({
        appId,
        catalogId: catalog.id,
        registrationIncarnation: incarnation,
        manifestVersion: manifest.version,
        manifest: jsonDocument(manifest),
        declaredSchema: jsonDocument(registration.tables),
        assetDigest,
        bridgeContractVersion: declaration?.compatibility.bridgeContractVersion ?? "undeclared",
        runtimeAbi: declaration?.compatibility.runtimeAbi ?? "undeclared",
      });
    };
    const result = await this.build.buildWithCollaborativeSnapshot(appId, resolved.entry.appDir, {
      store: this.options.store,
      buildIdForAssetDigest: (assetDigest, manifest) => identity(assetDigest, manifest).buildId,
    });
    if (!result.ok) throw new CollaborativeAppBuildResolutionError();
    const exact = identity(result.snapshot.assetDigest, result.snapshot.manifest);
    if (exact.buildId !== result.snapshot.buildId) throw new CollaborativeAppBuildResolutionError();
    await this.options.readiness.invalidateDriftedBuilds({
      ownerId,
      catalogId: catalog.id,
      currentBuildId: exact.buildId,
    });
    return {
      build: exact,
      artifactRef: `objects/${exact.buildId}`,
      declaration: declaration ?? null,
    };
  }
}
