import { z } from "zod/v4";
import { PreviewPairIdSchema, PreviewPairGenerationSchema } from "@matrix-os/contracts/preview-pair";
const Slug = z.string().max(80).regex(/^[a-z][a-z0-9-]+$/);
export function previewPairCloudResource(project: string, region: string, service: string) {
  Slug.parse(project); Slug.parse(region);
  z.string().max(23).regex(/^matrix-(?:platform|pair)-preview(?:-[a-z0-9-]+)?$/).parse(service);
  return `projects/${project}/locations/${region}/services/${service}`;
}
/** Full UUID, deterministic across controller restarts; no abbreviated ownership. */
export function previewPairRevisionName(service: string, pairId: string, generation: number) {
  PreviewPairIdSchema.parse(pairId); PreviewPairGenerationSchema.parse(generation);
  const value = `${service}-p-${pairId.replaceAll("-", "")}-g${generation}`;
  return z.string().max(63).regex(/^[a-z][a-z0-9-]+$/).parse(value);
}
