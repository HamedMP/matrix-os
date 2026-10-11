// Reviewed helper bytes stay stable while default-main workflow executions move.
import {readReviewedConfiguration} from './dedicated-api.mjs';
const sha=/^[a-f0-9]{40}$/;
const request={timeout:10_000};
export async function verifyControllerPin(github,repo,pin,configuration){
 if(!sha.test(pin||''))throw new Error('Invalid reviewed controller pin');
 const values=configuration??await readReviewedConfiguration(github,repo);
 if(values.MATRIX_CI_CONTROLLER_SHA!==pin)throw new Error('Reviewed controller pin configuration changed');
 const {data:main}=await github.rest.git.getRef({...repo,ref:'heads/main',request});
 if(!sha.test(main?.object?.sha||''))throw new Error('Invalid current main ref');
 const {data:comparison}=await github.rest.repos.compareCommitsWithBasehead({...repo,basehead:`${pin}...${main.object.sha}`,request});
 if(!['ahead','identical'].includes(comparison.status)||comparison.merge_base_commit?.sha!==pin)throw new Error('Reviewed controller pin is not an ancestor of main');
 return pin;
}
