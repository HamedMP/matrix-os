import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { previewPairTag, PreviewPairDigestSchema, PreviewPairOriginSchema } from "@matrix-os/contracts/preview-pair";
import type { PlatformDB } from "../db.js";
import type { EnabledPreviewPairConfig } from "./config.js";
import type { PreviewPairSourceProfile } from "./source-profile.js";
import { previewPairSourceFingerprint } from "./source-profile.js";
import { previewPairCloudResource, previewPairRevisionName } from "./cloud-resource.js";
import { createPreviewPairCloudAuthority } from "./cloud.js";
import { createPreviewPairOperationReader } from "./publication-operations.js";
import { beginPreviewPairPublication, readOwnedPublication, recordPreviewPairPublication, publicationParentAllows } from "./publication-journal.js";
import { buildPreviewPairPublication } from "./publication-payload.js";
import type { PreviewPairPublisher, PreviewPairPublicationInput, PreviewPairPublicationIdentity } from "./publication-contract.js";
import { PreviewPairConflictError } from "./repository.js";
import { PreviewPairUpstreamError, readPreviewPairJson } from "./http.js";

interface Options {
  db: PlatformDB; config: EnabledPreviewPairConfig; profile: PreviewPairSourceProfile;
  accessToken(signal: AbortSignal): Promise<string>; fetchImpl?: typeof fetch; now?: () => number;
}

/** Source-only IAM adapter. The API supplies a digest, never a resource, template,
 * credential or deploy command. Ambiguous effects are journaled and never retried. */
export function createPreviewPairPublisher(options: Options): PreviewPairPublisher | undefined {
  const { db, config, profile } = options, now = options.now ?? Date.now;
  if (!profile.imageRepository) return undefined;
  if (config.sourceProfileFingerprint !== previewPairSourceFingerprint(profile, config)) throw new PreviewPairConflictError();
  const repository = `${profile.region}-docker.pkg.dev/${profile.project}/${profile.imageRepository}/matrix-platform`;
  const resource = previewPairCloudResource(profile.project, profile.region, profile.service);
  const operations = createPreviewPairOperationReader({ ...options, project: profile.project, region: profile.region, service: profile.service });
  const provider = async (url: string, signal: AbortSignal, init?: RequestInit) => {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
    const token = z.string().min(1).max(16_384).parse(await options.accessToken(deadline));
    const response = await (options.fetchImpl ?? fetch)(url, { ...init, headers: { authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}) }, signal: deadline, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      console.warn("[preview-pair] publication provider unavailable", { stage: init?.method === "PATCH" ? "publication" : "publication_preflight", status: response.status });
    }
    return response;
  };
  const run = (path: string, signal: AbortSignal, init?: RequestInit) => provider(`https://run.googleapis.com/v2/${path}`, signal, init);
  async function inspect(input: PreviewPairPublicationIdentity, signal: AbortSignal) {
    let row = await readOwnedPublication(db, config, input, now());
    if (row.publication_state === "unissued") return { publication: "issuing" as const, ready: false };
    if (row.publication_state === "rejected") return { publication: "rejected" as const, ready: false };
    if (row.publication_state === "issuing") {
      const recovered = await operations.discover(row, signal);
      if (!recovered) return { publication: "issuing" as const, ready: false };
      row = await recordPreviewPairPublication(db, input, row.publication_id!, { operationName: recovered.name }, now());
    }
    const operation = await operations.read(row, signal);
    if (!operation?.done || operation.error !== undefined || row.image_sha256 === null) return { publication: "accepted" as const, ready: false };
    const live = z.object({ trafficStatuses: z.array(z.object({ tag: z.string().optional(), uri: z.string().optional() })).max(128) })
      .parse(await readPreviewPairJson(await run(resource, signal)));
    const origin = (kind: "ui" | "api") => {
      const matches = live.trafficStatuses.filter(entry => entry.tag === previewPairTag(input.pairId, input.generation, kind));
      if (matches.length !== 1) throw new PreviewPairUpstreamError();
      return PreviewPairOriginSchema.parse(matches[0]!.uri);
    };
    const browserOrigin = origin("ui"), apiOrigin = origin("api");
    const authority = createPreviewPairCloudAuthority({ config, project: profile.project, region: profile.region, service: profile.service,
      approvedSecretRefs: Object.values(profile.bindings).map(binding => binding.ref), expectedSecretBindings: profile.bindings,
      accessToken: () => options.accessToken(signal), fetchImpl: options.fetchImpl, now });
    const proof = await authority(browserOrigin, apiOrigin);
    signal.throwIfAborted();
    if (proof.pairId !== input.pairId || proof.generation !== input.generation || proof.sourceSha !== input.sourceSha
      || proof.image !== `${repository}@sha256:${row.image_sha256}`) throw new PreviewPairUpstreamError();
    // A concurrent stop invalidates readiness even if the remote reads succeeded.
    await readOwnedPublication(db, config, input, now());
    return { publication: "accepted" as const, ready: true, browserOrigin, apiOrigin, sourceProfileFingerprint: config.sourceProfileFingerprint };
  }
  async function observation<T>(read: () => Promise<T>): Promise<T> {
    try { return await read(); }
    catch (error: unknown) {
      if (error instanceof z.ZodError) {
        console.warn("[preview-pair] invalid publication observation", { stage: "publication_observation" });
        throw new PreviewPairUpstreamError();
      }
      throw error;
    }
  }
  return {
    context: { imageRepository: repository, clerkPublishableKey: config.clerkPublishableKey },
    ready: async (input, signal) => (await observation(() => inspect(input, signal))).ready,
    async publish(input: PreviewPairPublicationInput, signal) {
      return observation(async () => {
        PreviewPairDigestSchema.parse(input.imageSha256);
        const initial = await readOwnedPublication(db, config, input, now());
        if (initial.image_sha256 !== null && initial.image_sha256 !== input.imageSha256) throw new PreviewPairConflictError();
        if (initial.publication_state !== "unissued") return inspect(input, signal);
        const image = `${repository}@sha256:${input.imageSha256}`;
        const imageName = `projects/${profile.project}/locations/${profile.region}/repositories/${profile.imageRepository}/dockerImages/matrix-platform@sha256:${input.imageSha256}`;
        const artifact = z.object({ name: z.string().max(512), uri: z.string().max(512) }).parse(await readPreviewPairJson(await provider(
          `https://artifactregistry.googleapis.com/v1/projects/${profile.project}/locations/${profile.region}/repositories/${profile.imageRepository}/dockerImages/${encodeURIComponent(`matrix-platform@sha256:${input.imageSha256}`)}`, signal)));
        if (artifact.name !== imageName || artifact.uri !== image) throw new PreviewPairUpstreamError();
        const publicationId = randomUUID();
        const payload = buildPreviewPairPublication(await readPreviewPairJson(await run(resource, signal)), {
          input: { pairId: input.pairId, generation: input.generation, pr: input.pr, sourceSha: input.sourceSha, publicationId }, image, config, profile });
        // If operation discovery is unsupported, no create effect is safe: a lost
        // acknowledgement could otherwise escape cleanup authority forever.
        await operations.discover({ pair_id: input.pairId, generation: input.generation, source_sha: input.sourceSha, publication_id: publicationId }, signal);
        const existing = await run(`${resource}/revisions/${previewPairRevisionName(profile.service, input.pairId, input.generation)}`, signal);
        if (existing.status !== 404) { if (existing.ok) await existing.body?.cancel(); throw new PreviewPairConflictError(); }
        const reservation = await beginPreviewPairPublication(db, config, input, now(), publicationId);
        if (!reservation.issue) return inspect(input, signal);
        const fresh = await readOwnedPublication(db, config, input, now());
        if (fresh.publication_id !== publicationId || fresh.publication_state !== "issuing"
          || !await publicationParentAllows(db, input, now())) throw new PreviewPairConflictError();
        signal.throwIfAborted();
        const response = await run(`${resource}?updateMask=template,traffic`, signal, { method: "PATCH", body: JSON.stringify(payload.body) });
        if (!response.ok) {
          // A definite 4xx rejects this mutation. Transport failures, 5xx and
          // malformed acknowledgements remain issuing; never repeat the effect.
          if (response.status >= 400 && response.status < 500) await recordPreviewPairPublication(db, input, publicationId, { rejected: true }, now());
          throw new PreviewPairUpstreamError();
        }
        const operation = z.object({ name: z.string().max(256) }).parse(await readPreviewPairJson(response, 256 * 1024));
        await recordPreviewPairPublication(db, input, publicationId, { operationName: operations.validateName(operation.name) }, now());
        return { publication: "accepted" as const, ready: false };
      });
    },
  };
}
