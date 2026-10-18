import {APP_STORE_FIXED_BUILD,type AppStoreManifest} from '@matrix-os/contracts/app-store';
import {AppManifestSchema,type AppManifest} from '../app-runtime/manifest-schema.js';
import {assertRuntimeCompatible,RUNTIME_VERSION} from '../app-runtime/runtime-version.js';
/** Validate discovery and compatibility before the installed manifest becomes visible. */
export function installedStoreManifest(reviewed:AppStoreManifest,appSlug:string):AppManifest{
 const manifest=AppManifestSchema.parse({...reviewed,slug:appSlug,runtimeVersion:reviewed.runtimeVersion??`^${RUNTIME_VERSION}`,listingTrust:'community',build:{...APP_STORE_FIXED_BUILD,timeout:120},database:'postgres'});
 assertRuntimeCompatible(manifest);return manifest;
}
