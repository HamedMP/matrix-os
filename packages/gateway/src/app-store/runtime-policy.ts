import type {AppStoreInstallRecord} from '@matrix-os/contracts/app-store-gateway';
import type {AppCapabilityGrant} from '../app-capabilities/policy.js';
export function communityCapabilityGrant(record:AppStoreInstallRecord,grant:AppCapabilityGrant|null):AppCapabilityGrant{
 const services:Record<string,string[]>={};
 for(const declaration of [...record.capabilities.integrations.required,...record.capabilities.integrations.optional]){
  const actions=declaration.actions.filter(action=>grant?.services[declaration.service]?.includes(action));if(actions.length)services[declaration.service]=actions;
 }return {services};
}
export function communityQueryAllowed(record:AppStoreInstallRecord,identity:string,body:{app?:string;action:string;table?:string}):boolean{
 if(identity.replace(/^apps\//,'')!==record.appSlug||body.app?.replace(/^apps\//,'')!==record.appSlug||body.action==='listApps')return false;
 return !body.table||record.capabilities.tables.some(table=>table.name===body.table);
}
