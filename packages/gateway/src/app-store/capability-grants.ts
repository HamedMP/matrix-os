import {z} from 'zod/v4';
import type {AppStoreInstallRecord} from '@matrix-os/contracts/app-store-gateway';
import {AppCapabilityPolicySchema} from '../app-capabilities/policy.js';
import {pinDirectory,isFsError} from '../app-gallery/pinned-directory.js';
import {atomicPrivateFile} from './private-state.js';
/** Caller holds the owner's mutation coordinator; installs never broaden declared actions. */
export async function writeCommunityGrants(homePath:string,record:AppStoreInstallRecord):Promise<void>{
 const owner=await pinDirectory(homePath);let system;
 try{
  system=await owner.ensureChild('system');
  let capabilities:z.infer<typeof AppCapabilityPolicySchema>={apps:{}};
  try{capabilities=AppCapabilityPolicySchema.parse(JSON.parse((await system.readFile('app-capabilities.json',65_536)).toString('utf8')));}catch(error:unknown){if(!isFsError(error,'ENOENT'))throw error;}
  const services:Record<string,string[]>={};for(const row of [...record.capabilities.integrations.required,...record.capabilities.integrations.optional])services[row.service]=row.actions;
  const identity=`apps/${record.appSlug}`;capabilities.apps[identity]={services};
  AppCapabilityPolicySchema.parse(capabilities);
  await atomicPrivateFile(system,'app-capabilities.json',Buffer.from(JSON.stringify(capabilities)));
 }finally{await system?.close();await owner.close();}
}

/** Rollback only the affected app grant, preserving unrelated owner settings. */
export async function removeCommunityGrant(homePath:string,appSlug:string):Promise<void>{
 const owner=await pinDirectory(homePath);let system;
 try{system=await owner.ensureChild('system');let policy:z.infer<typeof AppCapabilityPolicySchema>;
 try{policy=AppCapabilityPolicySchema.parse(JSON.parse((await system.readFile('app-capabilities.json',65_536)).toString('utf8')));}catch(error:unknown){if(isFsError(error,'ENOENT'))return;throw error;}
 delete policy.apps[`apps/${appSlug}`];await atomicPrivateFile(system,'app-capabilities.json',Buffer.from(JSON.stringify(policy)));
 }finally{await system?.close();await owner.close();}
}
