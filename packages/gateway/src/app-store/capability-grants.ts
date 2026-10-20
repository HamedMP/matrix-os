import {z} from 'zod/v4';
import {AppAiRouteSelectionSchema} from '@matrix-os/contracts';
import type {AppStoreInstallRecord} from '@matrix-os/contracts/app-store-gateway';
import {AppCapabilityPolicySchema} from '../app-capabilities/policy.js';
import {pinDirectory,isFsError} from '../app-gallery/pinned-directory.js';
import {atomicPrivateFile} from './private-state.js';
const AiPolicy=z.strictObject({apps:z.array(z.string()).max(100),model:z.string().optional(),route:AppAiRouteSelectionSchema.optional()});
/** Caller holds the owner's mutation coordinator; installs never broaden declared actions. */
export async function writeCommunityGrants(homePath:string,record:AppStoreInstallRecord):Promise<void>{
 const owner=await pinDirectory(homePath);let system;
 try{
  system=await owner.ensureChild('system');
  let capabilities:z.infer<typeof AppCapabilityPolicySchema>={apps:{}};let ai:z.infer<typeof AiPolicy>={apps:[]};
  try{capabilities=AppCapabilityPolicySchema.parse(JSON.parse((await system.readFile('app-capabilities.json',65_536)).toString('utf8')));}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
  try{ai=AiPolicy.parse(JSON.parse((await system.readFile('app-ai.json',32_768)).toString('utf8')));}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
  const services:Record<string,string[]>={};for(const row of [...record.capabilities.integrations.required,...record.capabilities.integrations.optional])services[row.service]=row.actions;
  const identity=`apps/${record.appSlug}`;capabilities.apps[identity]={services};
  ai.apps=ai.apps.filter(app=>app!==identity);if(record.capabilities.permissions.includes('ai'))ai.apps.push(identity);
  AppCapabilityPolicySchema.parse(capabilities);AiPolicy.parse(ai);
  await atomicPrivateFile(system,'app-capabilities.json',Buffer.from(JSON.stringify(capabilities)));
  await atomicPrivateFile(system,'app-ai.json',Buffer.from(JSON.stringify(ai)));
 }finally{await system?.close();await owner.close();}
}
