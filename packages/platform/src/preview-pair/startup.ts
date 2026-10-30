import type { Dispatcher } from "undici";
import type { PlatformDB } from "../db.js";
import { verifyToken } from "@clerk/backend";
import { createClerkAuth, type ClerkAuth } from "../clerk-auth.js";
import { createCustomerVpsContext } from "../customer-vps-context.js";
import { createCustomerVpsSystemStore, type CustomerVpsObjectStore } from "../customer-vps-r2.js";
import { createPreviewPairRuntime, type PreviewPairRuntimeOptions } from "./wiring.js";
import type { CustomerVpsServiceDeps } from "../customer-vps-types.js";
import type { PreviewPairRoutesDeps } from "./routes.js";
import { createPreviewPairGoogleReader } from "./google-reader.js";
import { loadPreviewPairConfig, PreviewPairConfigurationError } from "./config.js";
import { loadPreviewPairSourceProfile, previewPairSourceFingerprint } from "./source-profile.js";
import { readPreviewPairSourceCredentials } from "./source-credentials.js";
import { createPreviewPairTargetDatabase, assertPreviewPairTargetPrepared } from "./target-database.js";
import { createPreviewPairIdentity } from "./identity.js";
import { createPreviewPairReaderAuthenticator } from "./auth.js";
import { createPreviewPairGitHub } from "./github.js";
import { createPreviewPairCloudAuthority } from "./cloud.js";
import { createPreviewPairCloudCleanup } from "./cleanup-cloud.js";
import { createPreviewPairIntentCloudCleanup } from "./intent-cloud.js";
import { createPreviewPairSourceAuthority } from "./source-authority.js";
import { startCustomerVpsReconciliationWorker, type CustomerVpsReconciliationWorker } from "../customer-vps-reconciliation-worker.js";
export interface ConfiguredPreviewPairRuntimeOptions {
  env: NodeJS.ProcessEnv; db: PlatformDB; clerkAuth?: ClerkAuth; customerVps?: CustomerVpsServiceDeps;
  objectStore?: CustomerVpsObjectStore; dispatcher: Dispatcher; funding: PreviewPairRuntimeOptions["funding"];
  registerCleanup(cleanup: () => Promise<void>): void; fetchImpl?: typeof fetch;
  google?: ReturnType<typeof createPreviewPairGoogleReader>; now?: () => number;
}
export interface ConfiguredPreviewPairRuntime {
  routes: PreviewPairRoutesDeps; start(): void; stop(): void; drain(): Promise<void>; close(): Promise<void>;
}
export async function createConfiguredPreviewPairRuntime(options: ConfiguredPreviewPairRuntimeOptions): Promise<ConfiguredPreviewPairRuntime | undefined> {
  const loaded = loadPreviewPairConfig(options.env);
  if (!loaded.enabled) return undefined;
  const profile = loadPreviewPairSourceProfile(options.env, loaded), context = options.customerVps;
  if (!profile || !context || !options.objectStore || !options.clerkAuth || !options.env.GITHUB_TOKEN
    || !options.env.CLERK_SECRET_KEY || !options.env.PLATFORM_JWT_SECRET || !options.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY) throw new PreviewPairConfigurationError();
  const config = { ...loaded, sourceProfileFingerprint: previewPairSourceFingerprint(profile, loaded) };
  const google = options.google ?? createPreviewPairGoogleReader({ projectNumber: profile.projectNumber, fetchImpl: options.fetchImpl });
  const credentials = await readPreviewPairSourceCredentials(profile, options.env, google.secret);
  const target = createPreviewPairTargetDatabase(credentials.PLATFORM_DATABASE_URL);
  let worker: CustomerVpsReconciliationWorker | undefined, stopped = false, closing: Promise<void> | undefined;
  const stop = () => { stopped = true; worker?.stop(); };
  const drain = () => worker?.drain() ?? Promise.resolve();
  const close = () => closing ??= (async () => { stop(); try { await drain(); } finally { await target.destroy(); } })();
  try {
    options.registerCleanup(close);
    const now = options.now ?? Date.now, fetchImpl = options.fetchImpl;
    const identity = createPreviewPairIdentity({ config, controlSecret: options.env.CLERK_SECRET_KEY,
      controlPublishableKey: options.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY, previewSecret: credentials.CLERK_SECRET_KEY, fetchImpl });
    const previewClerk = createClerkAuth({ verifyToken: token => verifyToken(token, { secretKey: credentials.CLERK_SECRET_KEY }) });
    const authenticateReader = createPreviewPairReaderAuthenticator({
      control: { clerk: options.clerkAuth, issuer: identity.controlIssuer, syncSecret: options.env.PLATFORM_JWT_SECRET },
      preview: { clerk: previewClerk, issuer: identity.previewIssuer, syncSecret: credentials.PLATFORM_JWT_SECRET } });
    const github = createPreviewPairGitHub({ token: options.env.GITHUB_TOKEN, reviewedControllerSha: config.reviewedControllerSha, fetchImpl });
    const cloudOptions = { config, project: profile.project, region: profile.region, service: profile.service,
      accessToken: () => google.accessToken(AbortSignal.timeout(10_000)), fetchImpl, now,
      approvedSecretRefs: Object.values(profile.bindings).map(binding => binding.ref), expectedSecretBindings: profile.bindings };
    const authority = createPreviewPairSourceAuthority({ db: options.db, config, github, identity,
      cloud: createPreviewPairCloudAuthority(cloudOptions), controlClerkSecret: options.env.CLERK_SECRET_KEY, fetchImpl });
    const privateContext = createCustomerVpsContext({ db: options.db, hetzner: context.hetzner, cloudInitTemplate: context.cloudInitTemplate,
      fetchDispatcher: options.dispatcher, config: { ...context.config,
      platformSecret: credentials.PLATFORM_SECRET, r2PrefixRoot: profile.r2Prefix, fundedAiEnabled: false,
      platformSpeechEnabled: false, goldenSnapshots: { ...context.config.goldenSnapshots, enabled: false } },
      systemStore: createCustomerVpsSystemStore({ r2: options.objectStore, r2PrefixRoot: profile.r2Prefix }) });
    const { service } = createPreviewPairRuntime({ db: options.db, target, config, context: privateContext,
      controlSecret: options.env.PLATFORM_SECRET ?? "", hostSecret: credentials.PLATFORM_SECRET, dispatcher: options.dispatcher,
      funding: options.funding, fetchImpl, now, authority: { ...authority,
        verifyFixtures: async signal => { signal.throwIfAborted(); await assertPreviewPairTargetPrepared(options.db, target); return authority.verifyFixtures(signal); },
        authority: async (candidate, signal) => { signal.throwIfAborted(); await assertPreviewPairTargetPrepared(options.db, target); return authority.authority(candidate, signal); } },
      retireCloudIntent: createPreviewPairIntentCloudCleanup({ db: options.db, profileFingerprint: config.sourceProfileFingerprint,
        project: profile.project, region: profile.region, service: profile.service, accessToken: google.accessToken, fetchImpl, now }),
      retireCloud: createPreviewPairCloudCleanup({ db: options.db, profileFingerprint: config.sourceProfileFingerprint, project: profile.project, region: profile.region,
        service: profile.service, accessToken: google.accessToken, fetchImpl, now }) });
    return { routes: { enabled: true, operatorSecret: profile.operatorSecret, service, authenticateReader }, stop, drain, close,
      start() { if (!stopped && !worker) worker = startCustomerVpsReconciliationWorker({ intervalMs: 30_000,
        runPass: async () => { await service.reconcile({ limit: 2 }); } }); } };
  } catch (error: unknown) {
    try { await close(); }
    catch (closeError: unknown) { console.warn("[preview-pair] startup close failed", closeError instanceof Error ? closeError.name : "UnknownError"); }
    throw error;
  }
}
