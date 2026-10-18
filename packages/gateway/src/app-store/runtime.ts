import {createStoreGeneralizer} from './generalizer.js';import type {StoreGeneralizerOptions} from './generalizer-provider.js';
import type {Hono} from 'hono';import {readBoundedJsonFileWithIdentity} from '../bounded-json-file.js';import {join} from 'node:path';
import {createAppStorePlatformClient} from './platform-client.js';import {createLocalStoreBuilder} from './local-builder.js';import {createStorePublishService} from './publish-service.js';import {createStoreInstallService} from './install-service.js';import {registerAppStoreRoutes} from './routes.js';import {createSubmissionPoller} from './submission-poller.js';
export async function startAppStoreRuntime(app:Hono,options:StoreGeneralizerOptions&{homePath:string;ownerIds:readonly string[];platformUrl?:string;token?:string;handle?:string;notify?:(change:{versionId:string;status:string})=>Promise<void>}){
 if(!options.platformUrl||!options.token||!options.handle){registerAppStoreRoutes(app,options);return {async close(){}};}
 const platform=createAppStorePlatformClient({platformUrl:options.platformUrl,token:options.token,handle:options.handle});
 const builder=createLocalStoreBuilder({homePath:options.homePath});
 const identity=await readBoundedJsonFileWithIdentity(join(options.homePath,'system/handle.json'),8192);
 const ownerTerms:string[]=[];if(identity?.value&&typeof identity.value==='object')for(const key of ['handle','aiHandle','displayName','email']){const value=(identity.value as Record<string,unknown>)[key];if(typeof value==='string'&&value.length>=3&&value.length<=100)ownerTerms.push(value);}
 const publish=createStorePublishService({homePath:options.homePath,platform,builder,ownerTerms,generalizer:createStoreGeneralizer(options.homePath,options)});const install=createStoreInstallService({homePath:options.homePath,platform,builder});
 registerAppStoreRoutes(app,{...options,platform,publish,install});
 for(const recover of [publish.recover,install.recover])try{await recover();}catch(error:unknown){console.warn('[app-store] Startup recovery unavailable',error instanceof Error?error.name:'UnknownError');}
 const poller=createSubmissionPoller({homePath:options.homePath,platform,notify:options.notify??(async()=>{})});poller.start();
 return {async close(){await Promise.allSettled([publish.close(),install.close(),poller.close()]);await builder.close();}};
}
