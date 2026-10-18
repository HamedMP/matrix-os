import { z } from "zod/v4";
import * as S from "./generated-store";
import * as G from "./generated-store-gateway";
import type { GalleryBridge } from "./model";
export type StoreClient = ReturnType<typeof createStoreClient>;
export type StoreStatus = S.AppStoreStatus;
export type StoreListing = G.AppStoreGatewayListingDetail;
export type StoreDraft = G.AppStoreDraftDetail;
export type StoreReview = S.AppStoreReviewDetail;
export { APP_STORE_CATEGORIES, APP_STORE_LICENSES } from "./generated-store";
export type {
  AppStoreCapabilities as StoreCapabilities,
  AppStoreReviewDecision as StoreDecision,
  AppStoreListingAction as StoreListingAction,
} from "./generated-store";
const messages = {
  invalid: "Some details are invalid. Check them and try again.",
  unauthorized: "Reconnect to your Matrix computer and try again.",
  forbidden: "You do not have access to this action.",
  not_found: "This item is no longer available.",
  conflict: "This item changed. Refresh to see the latest version.",
  limit: "Too many requests. Wait a moment and try again.",
  unavailable:
    "This feature is unavailable on your Matrix computer. Try again later.",
  build_failed:
    "The local build did not finish. Your existing app is kept. Try again.",
} as const;
class StoreError extends Error {
  constructor(readonly code: keyof typeof messages) {
    super(messages[code]);
  }
}
export function storeErrorMessage(error: unknown): string {
  if (error instanceof StoreError) return messages[error.code];
  if (
    error &&
    typeof error === "object" &&
    "error" in error &&
    typeof error.error === "string" &&
    Object.hasOwn(messages, error.error)
  )
    return messages[error.error as keyof typeof messages];
  return "This action could not finish. Try again.";
}
export function safeLaunchPath(value: unknown): value is string {
  return (
    typeof value === "string" && /^apps\/[a-z0-9][a-z0-9-]{0,63}$/.test(value)
  );
}
function query(input: Record<string, unknown>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined && value !== "") params.set(key, String(value));
  return params.size ? `?${params}` : "";
}
export function createStoreClient(bridge: GalleryBridge) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    try {
      const raw = await bridge.gatewayFetch(
        `/api/app-store${path}`,
        body === undefined
          ? undefined
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
        35000,
      );
      const error = S.AppStoreErrorSchema.safeParse(raw);
      if (error.success) throw new StoreError(error.data.error);
      return schema.parse(raw);
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (error instanceof Error && Object.hasOwn(messages, error.message))
        throw new StoreError(error.message as keyof typeof messages);
      // Hosts may reject transport errors; never copy their messages into UI state.
      throw new Error("Store request unavailable");
    }
  }
  const slug = (value: string) => S.AppStoreSlugSchema.parse(value);
  const id = (value: string) => S.AppStoreIdSchema.parse(value);
  return {
    status: () => request("/status", S.AppStoreStatusSchema),
    catalog: (input: Partial<S.AppStoreCatalogQuery>) =>
      request(
        `/listings${query(S.AppStoreCatalogQuerySchema.parse(input))}`,
        G.AppStoreGatewayCatalogPageSchema,
      ),
    detail: (value: string) =>
      request(`/listings/${slug(value)}`, G.AppStoreGatewayListingDetailSchema),
    install: (value: string, versionId: string, capabilitiesDigest: string) =>
      request(
        `/listings/${slug(value)}/install`,
        z.union([
          G.AppStoreInstallJobSchema,
          G.AppStoreLocalInstallResultSchema,
        ]),
        G.AppStoreInstallRequestSchema.parse({
          versionId,
          consent: { capabilitiesDigest },
        }),
      ),
    installJob: (value: string) =>
      request(`/installs/${id(value)}`, G.AppStoreInstallJobSchema),
    rate: (value: string, stars: number | null) =>
      request(
        `/listings/${slug(value)}/rating`,
        S.AppStoreRatingStateSchema,
        G.AppStoreGatewayRatingInputSchema.parse({ stars }),
      ),
    publishable: () =>
      request(
        "/publishable-apps",
        z.strictObject({
          apps: z.array(G.AppStorePublishableAppSchema).max(500),
        }),
      ),
    drafts: () =>
      request(
        "/drafts",
        z.strictObject({
          drafts: z.array(G.AppStoreDraftSummarySchema).max(5),
        }),
      ),
    createDraft: (app: string, accessSourceId?: string) =>
      request(
        "/drafts",
        G.AppStoreDraftSummarySchema,
        G.AppStoreCreateDraftSchema.parse({
          app,
          ...(accessSourceId ? { aiConsent: { accessSourceId } } : {}),
        }),
      ),
    draft: (value: string) =>
      request(`/drafts/${id(value)}`, G.AppStoreDraftDetailSchema),
    diff: (value: string, path: string) =>
      request(
        `/drafts/${id(value)}/diff${query(G.AppStoreDraftDiffQuerySchema.parse({ path }))}`,
        G.AppStoreDraftDiffSchema,
      ),
    revise: (value: string, instructions: string, accessSourceId?: string) =>
      request(
        `/drafts/${id(value)}/revise`,
        G.AppStoreDraftSummarySchema,
        G.AppStoreReviseDraftSchema.parse({
          instructions,
          ...(accessSourceId ? { aiConsent: { accessSourceId } } : {}),
        }),
      ),
    saveListing: (value: string, patch: G.AppStoreListingDraft) =>
      request(
        `/drafts/${id(value)}/listing`,
        G.AppStoreDraftDetailSchema,
        G.AppStoreListingDraftPatchSchema.parse(patch),
      ),
    submit: (value: string, license: string) =>
      request(
        `/drafts/${id(value)}/submit`,
        G.AppStoreDraftSummarySchema,
        G.AppStoreSubmitDraftSchema.parse({ consent: true, license }),
      ),
    deleteDraft: (value: string) =>
      request(
        `/drafts/${id(value)}/delete`,
        z.strictObject({ deleted: z.literal(true) }),
        {},
      ),
    submissions: (cursor?: string) =>
      request(
        `/submissions${query({ cursor })}`,
        S.AppStoreSubmissionsPageSchema,
      ),
    withdraw: (value: string) =>
      request(
        `/submissions/${id(value)}/withdraw`,
        S.AppStoreSubmissionSummarySchema,
        {},
      ),
    queue: (status: "in_review" | "changes_requested", cursor?: string) =>
      request(
        `/review/queue${query(S.AppStoreReviewQueueQuerySchema.parse({ status, cursor }))}`,
        S.AppStoreReviewQueuePageSchema,
      ),
    review: (value: string) =>
      request(`/review/versions/${id(value)}`, S.AppStoreReviewDetailSchema),
    reviewFile: (value: string, path: string, previous = false) =>
      request(
        `/review/versions/${id(value)}/file${query(S.AppStoreReviewFileQuerySchema.parse({ path, ...(previous ? { previous: "1" } : {}) }))}`,
        S.AppStoreReviewFileSchema,
      ),
    decide: (value: string, decision: S.AppStoreReviewDecision) =>
      request(
        `/review/versions/${id(value)}/decision`,
        S.AppStoreReviewQueueItemSchema,
        S.AppStoreReviewDecisionSchema.parse(decision),
      ),
    listingAction: (value: string, action: S.AppStoreListingAction) =>
      request(
        `/review/listings/${id(value)}/action`,
        S.AppStoreListingSummarySchema,
        S.AppStoreListingActionSchema.parse(action),
      ),
    open: async (name: string, path: string) => {
      if (!safeLaunchPath(path) || !bridge.openApp)
        throw new StoreError("unavailable");
      try {
        await bridge.openApp(name.slice(0, 60), path);
      } catch (error) {
        console.warn(
          "Store app launch unavailable",
          error instanceof Error ? error.name : "UnknownError",
        );
        throw new StoreError("unavailable");
      }
    },
  };
}
