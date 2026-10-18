import {AppStoreDownloadGrantSchema,AppStoreManifestSchema,deriveAppStoreCapabilities,capabilitiesDigest,canonicalJson,type AppStoreDownloadGrant} from '@matrix-os/contracts/app-store';
import {bundleDigest,decodeAppBundle} from '@matrix-os/contracts/app-store-bundle';
import {verifyStoreApproval,type StoreSigningKey} from '@matrix-os/contracts/app-store-signing';
import {StoreError} from './platform-client.js';
export async function validateStoreGrant(input:AppStoreDownloadGrant,source:Buffer,keys:readonly StoreSigningKey[],consentDigest:string){
 const grant=AppStoreDownloadGrantSchema.parse(input);
 const derived=deriveAppStoreCapabilities(grant.manifest);const digest=await capabilitiesDigest(derived);
 if(source.length!==grant.source.size||bundleDigest(source)!==grant.source.sha256||digest!==grant.capabilitiesDigest||digest!==consentDigest||canonicalJson(derived)!==canonicalJson(grant.capabilities)||!verifyStoreApproval(grant,grant.approval,keys))throw new StoreError('invalid');
 const decoded=decodeAppBundle(source,{kind:'source'});
 const manifest=AppStoreManifestSchema.parse(JSON.parse(decoded.files.get('matrix.json')!.toString('utf8')));
 if(canonicalJson(manifest)!==canonicalJson(grant.manifest)||manifest.version!==grant.version)throw new StoreError('invalid');
 return {grant,manifest,files:decoded.files};
}
