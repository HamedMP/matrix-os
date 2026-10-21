import {communityRecord} from './provenance.js';
import {computeDistributionStatus,sandboxCapabilities,type DistributionStatus} from '../app-runtime/distribution-policy.js';
/** Author-edited trust flags cannot remove an installed community app's provenance. */
export async function runtimeDistribution(homePath:string,slug:string,listingTrust:string|undefined):Promise<DistributionStatus>{
 const installed=await communityRecord(homePath,slug);
 if(installed)return 'installable';
 // A community manifest without a signed-source installation is never trusted by an env bypass.
 if(listingTrust==='community')return 'blocked';
 return computeDistributionStatus(listingTrust,sandboxCapabilities());
}
