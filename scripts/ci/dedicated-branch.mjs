// Branch identity reads use the branch API. Git refs advertise a 300-second
// polling interval, which cannot fit the reviewed short lease/source deadlines.
const sha=/^[a-f0-9]{40}$/;
const valid=value=>typeof value==='string'&&value.length>0&&value.length<=1024&&!/[\x00-\x20\x7f~^:?*\[\\]/.test(value)&&!value.includes('..')&&!value.includes('@{')&&!value.endsWith('/')&&!value.endsWith('.');
export async function readCurrentBranchSha(github,repo,branch,request={timeout:10000}){
 if(!valid(branch))throw new Error('Invalid live branch ref');
 const {data}=await github.rest.repos.getBranch({...repo,branch,request});
 if(data?.name!==branch||!sha.test(data?.commit?.sha||''))throw new Error('Invalid live branch ref response');
 return data.commit.sha;
}
