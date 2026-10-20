import {describe,it,expect} from 'vitest';
import {communityCapabilityGrant,communityQueryAllowed} from '../../../packages/gateway/src/app-store/runtime-policy.js';
const record={appSlug:'local-app',capabilities:{integrations:{required:[{service:'gmail',actions:['list']}],optional:[]},permissions:[],tables:[{name:'records',columns:{}}]}};
describe('community grants',()=>{
 it('intersects owner grants with reviewed and consented actions',()=>{
  expect(communityCapabilityGrant(record as never,{services:{gmail:['list','delete'],slack:['send']}})).toEqual({services:{gmail:['list']}});
 });
 it('allows only its own database and declared tables',()=>{
  expect(communityQueryAllowed(record as never,'apps/local-app',{app:'apps/local-app',action:'find',table:'records'})).toBe(true);
  expect(communityQueryAllowed(record as never,'apps/local-app',{app:'apps/other',action:'find',table:'records'})).toBe(false);
  expect(communityQueryAllowed(record as never,'apps/local-app',{app:'apps/local-app',action:'listApps'})).toBe(false);
 });
});
