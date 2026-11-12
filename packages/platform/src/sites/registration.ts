import type { Hono } from 'hono';
import type { Agent } from 'undici';
import type { PlatformDB } from '../db.js';
import type { CustomerVpsObjectStore } from '../customer-vps-r2.js';
import { createSitesService } from './service.js';
import { createSiteManagementRoutes } from './management-routes.js';
import { createSitePublicRoutes } from './public-routes.js';
import { createSiteSubmissionTransport } from './submission-transport.js';
import type { SiteTelemetryCapture } from './telemetry.js';
export function registerSiteRoutes(app: Hono<any>, options: {
    db: PlatformDB;
    platformSecret: string;
    storage?: CustomerVpsObjectStore;
    edgeSecret?: string;
    edgePreviousSecret?: string;
    dispatcher?: Agent;
    env?: NodeJS.ProcessEnv;
    captureEvent?: SiteTelemetryCapture;
}) {
    const service = createSitesService(options);
    app.route('/internal/containers/:handle/sites', createSiteManagementRoutes({ ...options, service }));
    app.route('/public/sites', createSitePublicRoutes({ service, edgeSecret: options.edgeSecret,
        edgePreviousSecret: options.edgePreviousSecret, submit: createSiteSubmissionTransport(options),
        captureEvent: options.captureEvent }));
}
