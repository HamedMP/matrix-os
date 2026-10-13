// Reviewed helper bytes stay stable while default-main workflow executions move.
import {readCurrentBranchSha} from './dedicated-branch.mjs';
import {readReviewedConfiguration} from './dedicated-api.mjs';
const sha=/^[a-f0-9]{40}$/;
const request={timeout:10_000};
export async function verifyControllerPin(github,repo,pin,configuration){
 if(!sha.test(pin||''))throw new Error('Invalid reviewed controller pin');
 const values=configuration??await readReviewedConfiguration(github,repo);
 if(values.MATRIX_CI_CONTROLLER_SHA!==pin)throw new Error('Reviewed controller pin configuration changed');
 const main=await readCurrentBranchSha(github,repo,'main',request);
 const {data:comparison}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${pin}...${main}`,request});
 if(!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==pin)throw new Error('Reviewed controller pin is not an ancestor of main');
 return pin;
}
