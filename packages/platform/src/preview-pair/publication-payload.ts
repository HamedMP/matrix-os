import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema, PreviewPairPrSchema, PreviewPairShaSchema,
  PreviewPairOriginSchema, previewPairTag } from "@matrix-os/contracts/preview-pair";
import type { PreviewPairSourceProfile } from "./source-profile.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import { PreviewPairConflictError } from "./repository.js";
const Traffic = z.object({ type: z.enum(["TRAFFIC_TARGET_ALLOCATION_TYPE_UNSPECIFIED", "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST",
  "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION"]).optional(), revision: z.string().max(256).optional(),
  tag: z.string().max(63).optional(), percent: z.number().int().min(0).max(100).default(0) });
const Service = z.object({ name: z.string().max(256), etag: z.string().min(1).max(256),
  generation: z.string().regex(/^[1-9][0-9]*$/).max(20), observedGeneration: z.string().regex(/^[1-9][0-9]*$/).max(20),
  reconciling: z.literal(false), terminalCondition: z.object({ type: z.literal("Ready"), state: z.literal("CONDITION_SUCCEEDED") }),
  latestReadyRevision: z.string().max(256), uri: z.string().max(512), urls: z.array(z.string().max(512)).max(128).default([]),
  traffic: z.array(Traffic).min(1).max(126), trafficStatuses: z.array(Traffic).min(1).max(128) });
const Identity = z.strictObject({ pairId: PreviewPairIdSchema, generation: PreviewPairGenerationSchema,
  pr: PreviewPairPrSchema, sourceSha: PreviewPairShaSchema, publicationId: PreviewPairIdSchema });

/** Whitelist a new runtime template. Never copy the source service's env,
 * credentials, mounts or sidecars into an unmerged candidate. */
export function buildPreviewPairPublication(raw: unknown, options: { input: z.infer<typeof Identity>; image: string;
  profile: PreviewPairSourceProfile; config: EnabledPreviewPairConfig }) {
  try {
    const { profile, config } = options, input = Identity.parse(options.input), service = Service.parse(raw);
    const resource = previewPairCloudResource(profile.project, profile.region, profile.service);
    const imagePrefix = `${profile.region}-docker.pkg.dev/${profile.project}/${profile.imageRepository}/matrix-platform@sha256:`;
    if (!profile.imageRepository || !options.image.startsWith(imagePrefix) || !/^[a-f0-9]{64}$/.test(options.image.slice(imagePrefix.length))
      || service.name !== resource || service.generation !== service.observedGeneration) throw new PreviewPairConflictError();
    const baseOrigins: string[] = []; // At most129 provider-supplied URL entries.
    for (const candidate of [service.uri, ...service.urls]) {
      let url: URL;
      try { url = new URL(candidate); }
      catch (error: unknown) { if (error instanceof TypeError) continue; throw error; }
      if (url.protocol === "https:" && !url.username && !url.password && !url.port && !url.search && !url.hash
        && url.pathname === "/" && url.hostname.startsWith(`${profile.service}-`) && !url.hostname.includes("---")
        && /^[a-z0-9-]+\.a\.run\.app$/.test(url.hostname) && !baseOrigins.includes(url.origin)) baseOrigins.push(url.origin);
    }
    if (baseOrigins.length !== 1) throw new PreviewPairConflictError();
    const tagged = (kind: "ui" | "api") => PreviewPairOriginSchema.parse(`https://${previewPairTag(input.pairId, input.generation, kind)}---${new URL(baseOrigins[0]!).hostname}`);
    const browserOrigin = tagged("ui"), apiOrigin = tagged("api"), tags = ["ui", "api"].map(kind => previewPairTag(input.pairId, input.generation, kind as "ui" | "api"));
    if ([...service.traffic, ...service.trafficStatuses].some(entry => entry.tag && tags.includes(entry.tag))
      || service.traffic.reduce((sum, entry) => sum + entry.percent, 0) !== 100) throw new PreviewPairConflictError();
    const short = (value: string) => {
      const name = value.startsWith(`${resource}/revisions/`) ? value.slice(`${resource}/revisions/`.length) : value;
      if (!name.startsWith(`${profile.service}-`) || !/^[a-z][a-z0-9-]{1,62}$/.test(name)) throw new PreviewPairConflictError();
      return name;
    };
    const traffic = service.traffic.map(entry => {
      const latest = entry.type === "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST" || !entry.revision;
      const revision = short(latest ? service.latestReadyRevision : entry.revision!);
      if (latest && service.trafficStatuses.filter(status => status.tag === entry.tag && status.percent === entry.percent
        && status.revision && short(status.revision) === revision).length !== 1) throw new PreviewPairConflictError();
      return { type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION" as const, revision, percent: entry.percent,
        ...(entry.tag === undefined ? {} : { tag: entry.tag }) };
    });
    const revision = previewPairRevisionName(profile.service, input.pairId, input.generation);
    const literals = { MATRIX_PREVIEW_PAIR_RUNTIME_ONLY: "true", MATRIX_PREVIEW_PAIR_ENABLED: "false", MATRIX_PREVIEW_PAIR_MAINTENANCE_ENABLED: "false",
      CUSTOMER_VPS_ENABLED: "false", MATRIX_FUNDED_AI_RUNTIME_ENABLED: "false", MATRIX_PREVIEW_RUNTIME_ACCESS_ENABLED: "false", GOLDEN_SNAPSHOTS_ENABLED: "false",
      MATRIX_PREVIEW_PAIR_ID: input.pairId, MATRIX_PREVIEW_PAIR_GENERATION: String(input.generation), MATRIX_PREVIEW_PAIR_PR: String(input.pr),
      MATRIX_PREVIEW_PAIR_PUBLICATION_ID: input.publicationId, MATRIX_BUILD_SHA: input.sourceSha,
      MATRIX_COLLABORATION_TICKET_ACTIVE_KEY_ID: profile.activeTicketKeyId, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
      PLATFORM_PUBLIC_URL: apiOrigin, MATRIX_API_ORIGIN: apiOrigin, MATRIX_APP_ORIGIN: browserOrigin,
      NEXT_PUBLIC_MATRIX_APP_URL: browserOrigin, MATRIX_APP_DOMAIN_HOSTS: new URL(browserOrigin).hostname };
    const env = [...Object.entries(literals).map(([name, value]) => ({ name, value })),
      ...Object.entries(profile.bindings).map(([name, binding]) => ({ name, valueSource: {
        secretKeyRef: { secret: `projects/${profile.project}/secrets/${binding.ref}`, version: binding.version } } }))];
    return { browserOrigin, apiOrigin, body: { name: resource, etag: service.etag,
      template: { revision, serviceAccount: config.serviceAccount, scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        timeout: "300s", maxInstanceRequestConcurrency: 80, containers: [{ image: options.image, ports: [{ containerPort: 8080 }], env,
          resources: { limits: { cpu: "1", memory: "1Gi" } } }] },
      traffic: [...traffic, ...tags.map(tag => ({ type: "TRAFFIC_TARGET_ALLOCATION_TYPE_REVISION" as const, revision, tag, percent: 0 }))] } };
  } catch (error: unknown) {
    if (error instanceof z.ZodError || error instanceof TypeError || error instanceof PreviewPairConflictError) throw new PreviewPairConflictError();
    throw error;
  }
}
