import type { Hono } from 'hono';
import type { Agent } from 'undici';
import { sql } from 'kysely';
import type { PlatformDB } from '../db.js';
import type { CustomerVpsObjectStore } from '../customer-vps-r2.js';
import { createSitesService } from './service.js';
import { createSiteManagementRoutes } from './management-routes.js';
import { createSitePublicRoutes } from './public-routes.js';
import { createSiteSubmissionTransport } from './submission-transport.js';
import type { SiteTelemetryCapture } from './telemetry.js';
import type { ClerkAuth } from '../clerk-auth.js';
export interface SiteEmailReadiness {
    edgeExchange: boolean;
    clerkInline: boolean;
    lifecycleWebhook: boolean;
    mailDelivery: boolean;
}
/** Schema is read from the authoritative migration marker, not an env claim. */
export async function readSiteEmailCapability(db: PlatformDB, env: NodeJS.ProcessEnv, readiness: SiteEmailReadiness): Promise<boolean> {
    await db.ready;
    if (env.MATRIX_PAGE_EMAIL_INVITATIONS_ENABLED !== 'true'
        || !readiness.edgeExchange || !readiness.clerkInline
        || !readiness.lifecycleWebhook || !readiness.mailDelivery) return false;
    const marker = await sql<{ generation: number; fingerprint: string }>`
      SELECT generation, fingerprint FROM platform_schema_revisions WHERE scope = 'sites'`.execute(db.executor);
    return marker.rows[0]?.generation === 3
        && marker.rows[0]?.fingerprint === 'public-app-sites-email-invitations-v3';
}
export function registerSiteRoutes(app: Hono<any>, options: {
    db: PlatformDB;
    platformSecret: string;
    storage?: CustomerVpsObjectStore;
    edgeSecret?: string;
    edgePreviousSecret?: string;
    dispatcher?: Agent;
    env?: NodeJS.ProcessEnv;
    captureEvent?: SiteTelemetryCapture;
    emailReadiness?: SiteEmailReadiness;
    clerkAuth?: ClerkAuth;
}) {
    if (!app || !options?.db || !options.platformSecret)
        throw new Error('Sites registration requires application, database, and platform secret');
    const emailCapability = () => readSiteEmailCapability(options.db, options.env ?? process.env,
        options.emailReadiness ?? { edgeExchange: false, clerkInline: false, lifecycleWebhook: false, mailDelivery: false });
    const env = options.env ?? process.env;
    const service = createSitesService({ ...options, emailCapability,
        emailSessionSecret: env.ACCOUNT_DELETION_SECRET });
    app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ ...options, service }));
    const email = options.clerkAuth && env.CLERK_SECRET_KEY && env.ACCOUNT_DELETION_SECRET
        ? { db: options.db, enabled: emailCapability, secret: env.ACCOUNT_DELETION_SECRET,
            clerkSecretKey: env.CLERK_SECRET_KEY, publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
            verify: options.clerkAuth.verify }
        : undefined;
    app.route('/public/sites', createSitePublicRoutes({ service, edgeSecret: options.edgeSecret,
        edgePreviousSecret: options.edgePreviousSecret, submit: createSiteSubmissionTransport(options),
        captureEvent: options.captureEvent, email }));
}
