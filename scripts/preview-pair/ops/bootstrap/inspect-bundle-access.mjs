// Bootstrap/recovery only: read ../README.md; resources already exist.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
const require = createRequire(process.env.MATRIX_PREVIEW_CANDIDATE_ROOT + '/packages/gateway/package.json');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
const versions = {};
const secret = name => {
 const metadata=JSON.parse(execFileSync('gcloud',['secrets','versions','describe','latest',`--secret=${name}`,'--project=matrix-os-1144','--format=json'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}));
 if(metadata.state!=='ENABLED')throw new Error('Approved credential version unavailable');
 const version=metadata.name.split('/').at(-1);versions[name]=version;
 return execFileSync('gcloud',['secrets','versions','access',version,`--secret=${name}`,'--project=matrix-os-1144'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000}).trim();
};
const credentials={accessKeyId:secret('r2-bundles-access-key-id'),secretAccessKey:secret('r2-bundles-secret-access-key')};
const bucket=secret('r2-bundles-bucket'),endpoint=secret('r2-bundles-endpoint');
if(bucket!=='matrixos-bundles'||!process.env.MATRIX_PREVIEW_BUNDLES_ENDPOINT || endpoint!==process.env.MATRIX_PREVIEW_BUNDLES_ENDPOINT)throw new Error('Approved bundle destination changed');
const client=new S3Client({region:'auto',endpoint,credentials,maxAttempts:1});
try{
 const result=await client.send(new HeadBucketCommand({Bucket:bucket}),{abortSignal:AbortSignal.timeout(10000)});
 const receipt={checkedAt:new Date().toISOString(),authorization:'Explicit requester approval: existing shared bundle credentials for matrixos-bundles only; release credential for registration only. No sync-store probe or candidate access.',bucket,endpoint,headBucketStatus:result.$metadata.httpStatusCode,sourceSecretVersions:versions,scopeLimitation:'Shared publishing credential use is authorized. Its complete issuance policy was not inspected; no dedicated-key isolation is claimed.',objectReads:0,objectWrites:0,syncStoreCalls:0};
 await writeFile(new URL('./bundle-access-receipt.json',import.meta.url),JSON.stringify(receipt,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(receipt,null,2));
}finally{client.destroy();}
