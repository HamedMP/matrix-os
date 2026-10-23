import type { SitePublishing } from '@matrix-os/contracts';
export interface SitesTable {
    id: string;
    owner_id: string;
    machine_id: string;
    app_slug: string;
    title: string;
    description: string;
    slug: string | null;
    revision: number;
    status: 'published' | 'unpublished';
    active_version: string | null;
    created_at: string;
}
export interface SiteVersionsTable {
    id: string;
    site_id: string;
    created_at: string;
    config: SitePublishing;
    files: {
        path: string;
        contentType: string;
        bytes: number;
    }[];
}
export interface SiteAliasesTable {
    slug: string;
    site_id: string | null;
}
export interface SiteOwner {
    ownerId: string;
    machineId: string;
    appSlug: string;
    authenticatedRuntime?: { handle: string; runtimeSlot: string; runtimeTokenEpoch: number };
}
export class SiteError extends Error {
    constructor(public code: 'conflict' | 'not_found' | 'unavailable' | 'invalid_request') { super(`Site ${code}`); }
}
