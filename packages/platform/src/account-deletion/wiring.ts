import type { PlatformDB } from '../db.js';
import type { CustomerVpsService } from '../customer-vps.js';
import { createHetznerClient } from '../customer-vps-hetzner.js';
import { loadCustomerVpsConfig } from '../customer-vps-config.js';
import { createAccountDeletionAdapters, type AccountDeletionAdapterOptions } from './adapters.js';
import { createAccountDeletionObjectStore } from './storage.js';
import { listAccountExportFiles, exportOwnerPlatformData } from './export.js';
import { createAccountDeletionService } from './service.js';
import { registerNativeAppleAuthorization } from './native-apple.js';
import { withAccountDeletionAdmission } from './admission.js';
import { hashAccountDeletionOwner } from './repository.js';
import { startAccountDeletionWorker } from './worker.js';
import type { AccountDeletionService } from './types.js';
import type { AccountDeletionExport } from './routes.js';

export interface AccountDeletionRuntime {
 service:AccountDeletionService;
 exportData(owner:string,cursor?:string):Promise<AccountDeletionExport>;
 exportPlatformData(owner:string):Promise<unknown>;
 registerAppleAuthorization(owner:string,code:string):Promise<void>;
 stop():void;
 drain():Promise<void>;
 close():void;
}
export async function createConfiguredAccountDeletionRuntime(input:{
 db:PlatformDB;env:NodeJS.ProcessEnv;customerVpsService?:CustomerVpsService;backgroundWorkersEnabled?:boolean;
 pipedream?:AccountDeletionAdapterOptions['pipedream'];
 nativeGmail?:AccountDeletionAdapterOptions['nativeGmail'];
 customMcp?:AccountDeletionAdapterOptions['customMcp'];
}):Promise<AccountDeletionRuntime|undefined> {
 const env=input.env;
 if(env.ACCOUNT_DELETION_ENABLED!=='true')return undefined;
 const secret=env.ACCOUNT_DELETION_SECRET;
 const clerkSecretKey=env.CLERK_SECRET_KEY;
 if(!secret||secret.length<32||!clerkSecretKey)throw Error('Account deletion configuration unavailable');
 const accessKeyId=env.S3_ACCESS_KEY_ID??env.R2_ACCESS_KEY_ID;
 const secretAccessKey=env.S3_SECRET_ACCESS_KEY??env.R2_SECRET_ACCESS_KEY;
 if(!accessKeyId||!secretAccessKey)throw Error('Account deletion storage configuration unavailable');
 const root=env.R2_PREFIX_ROOT??'matrixos-sync';
 const store=createAccountDeletionObjectStore({accessKeyId,secretAccessKey,bucket:env.S3_BUCKET??env.R2_BUCKET??'matrixos-sync',
 endpoint:env.S3_ENDPOINT??env.R2_ENDPOINT,accountId:env.R2_ACCOUNT_ID,forcePathStyle:env.S3_FORCE_PATH_STYLE==='true'});
 try {
 const appleValues=[env.APPLE_TEAM_ID,env.APPLE_KEY_ID,env.APPLE_PRIVATE_KEY,env.APPLE_SERVICES_ID,env.APPLE_NATIVE_CLIENT_ID];
 if(appleValues.some(Boolean)&&!appleValues.every(Boolean))throw Error('Account deletion Apple configuration unavailable');
 const adapters=createAccountDeletionAdapters({db:input.db,clerkSecretKey,credentialSecret:secret,r2PrefixRoot:root,objectStore:store,
 ownerHash:owner=>hashAccountDeletionOwner(owner,secret),
 customerVpsService:input.customerVpsService,
 hetzner:input.customerVpsService?createHetznerClient(loadCustomerVpsConfig(env)):undefined,
 stripeSecretKey:env.STRIPE_SECRET_KEY,pipedream:input.pipedream,nativeGmail:input.nativeGmail,customMcp:input.customMcp,matrixHomeserverUrl:env.MATRIX_HOMESERVER_URL,
 apple:appleValues.every(Boolean)?{teamId:env.APPLE_TEAM_ID!,keyId:env.APPLE_KEY_ID!,privateKey:env.APPLE_PRIVATE_KEY!,
 serviceId:env.APPLE_SERVICES_ID!,nativeClientId:env.APPLE_NATIVE_CLIENT_ID!}:undefined,
 twilio:env.TWILIO_ACCOUNT_SID&&env.TWILIO_AUTH_TOKEN?{accountSid:env.TWILIO_ACCOUNT_SID,authToken:env.TWILIO_AUTH_TOKEN,
 publicBaseUrl:env.PLATFORM_PUBLIC_URL??'https://app.matrix-os.com'}:undefined});
 const service=createAccountDeletionService({db:input.db.kysely,adapters,secret});
 const worker=input.backgroundWorkersEnabled===false?undefined:startAccountDeletionWorker({service});
 return {service,
 async exportData(owner,cursor){const result=await listAccountExportFiles(store,owner,root,cursor);return {
 downloads:result.files.map(file=>({name:file.path,url:file.downloadUrl})),migrationUrl:'/runtime',
 instructions:[result.migrationInstructions],nextCursor:result.nextCursor};},
 exportPlatformData:owner=>exportOwnerPlatformData(input.db,owner),
 async registerAppleAuthorization(owner,code){
   if(!appleValues.every(Boolean))throw Error('Apple authorization unavailable');
   await withAccountDeletionAdmission(input.db,owner,async()=>registerNativeAppleAuthorization({clerkSecretKey,credentialSecret:secret,
     apple:{teamId:env.APPLE_TEAM_ID!,keyId:env.APPLE_KEY_ID!,privateKey:env.APPLE_PRIVATE_KEY!,serviceId:env.APPLE_SERVICES_ID!,nativeClientId:env.APPLE_NATIVE_CLIENT_ID!}},owner,code),env);
 },
 stop(){worker?.stop();},async drain(){await worker?.drain();},close(){store.destroy?.();}};
 }catch(error:unknown){store.destroy?.();throw error;}
}
