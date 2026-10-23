import {createHash} from 'node:crypto';
import {deflateRawSync} from 'node:zlib';
import {canonicalRequest} from '../../../scripts/ci/dedicated-ssh.mjs';
export function receiptFor(summary:any,runId=123,parents=[summary.baseSha,summary.headSha]){
 const request={repository:'HamedMP/matrix-os',...(summary.sourceKind?{sourceKind:summary.sourceKind}:{}),prNumber:summary.prNumber,headSha:summary.headSha,baseSha:summary.baseSha,baseRef:summary.baseRef,mergeSha:summary.sourceSha,mergeParents:parents,requestingRunId:summary.requestingRunId,requestingRunAttempt:summary.requestingRunAttempt,controllerRunId:runId,controllerRunAttempt:summary.controllerAttempt,controllerSha:summary.controllerSha,controllerRef:'refs/heads/main',controllerWorkflow:'.github/workflows/ci-dedicated.yml',imageDigest:summary.imageDigest,harnessDigest:summary.harnessDigest,mode:summary.mode,suite:'qualification',limits:{unitWorkers:16,cpu:30,memoryMiB:114688,workMiB:65536,tmpMiB:8192,homeMiB:1024,pids:4096,shmMiB:2048}};
 const common={schemaVersion:1,leaseId:summary.leaseId,requestDigest:createHash('sha256').update(canonicalRequest(request)).digest('hex'),request,sourceSha:summary.sourceSha,parents,imageDigest:summary.imageDigest,harnessDigest:summary.harnessDigest,containerGone:true};
 if(summary.outcome)return {...common,qualified:false,outcome:summary.outcome,status:76,reason:summary.reason,stage:summary.stage,workloadStarted:summary.workloadStarted,containerGone:summary.containerGone,...(summary.outcome==='transport-unavailable'?{proofOrigin:summary.proofOrigin,grantSent:summary.grantSent,controlBytes:summary.controlBytes,handshakeBoundSeconds:summary.handshakeBoundSeconds}:{})};
 const electron=['account-organization-picker','file-download','canonical-input','provider-auth-terminal','agents-providers-figma','agents-providers-button-contrast','provider-settings-idle','project-folder-picker-layout','project-deletion','terminal-file-drop','terminal-snapshot','release-alignment','chat-title-layout','terminal-clipboard'].map(n=>`tests/e2e/desktop/${n}.e2e.test.ts`).concat('tests/e2e/provider-authorization-electron.e2e.test.ts').sort();
 const reports=Object.fromEntries(['unit','general','grid','electron-download','electron-input','electron-providers','electron-folder','electron-deletion','electron-clipboard','electron-drop','electron-snapshot','electron-release','electron-title'].map(name=>[name,{files:name==='electron-providers'?5:name==='electron-input'?2:1,total:1,passed:1,skipped:0,failed:0,inventoryComplete:true}]));
 return {...common,qualified:true,exitCode:0,lockSha256:'a'.repeat(64),inventorySha256:'b'.repeat(64),phaseCount:56,guardCount:14,independentHostSourceChecks:4,allPhasesPassed:true,allGuardsClean:true,queueSeconds:0,wallSeconds:1,startedUtc:'2026-10-11T10:00:00Z',finishedUtc:'2026-10-11T10:00:01Z',requiredElectronFiles:electron,reports,smoke:{comparedExports:1,svgRenderComparisons:1,distinctIconModules:1,missingExportControl:'rejected',negativeAliasControl:'rejected'}};
}
export function receiptZip(value:any,name='receipt.json',options:{deflate?:boolean,descriptor?:boolean}={}){
 const bytes=Buffer.from(JSON.stringify(value)),filename=Buffer.from(name);let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}crc=(crc^0xffffffff)>>>0;
 const payload=options.deflate?deflateRawSync(bytes):bytes,method=options.deflate?8:0,flags=options.descriptor?0x808:0;
 const descriptor=options.descriptor?Buffer.alloc(16):Buffer.alloc(0);if(options.descriptor){descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(crc,4);descriptor.writeUInt32LE(payload.length,8);descriptor.writeUInt32LE(bytes.length,12);}
 const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(flags,6);local.writeUInt16LE(method,8);if(!options.descriptor){local.writeUInt32LE(crc,14);local.writeUInt32LE(payload.length,18);local.writeUInt32LE(bytes.length,22);}local.writeUInt16LE(filename.length,26);
 const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(flags,8);central.writeUInt16LE(method,10);central.writeUInt32LE(crc,16);central.writeUInt32LE(payload.length,20);central.writeUInt32LE(bytes.length,24);central.writeUInt16LE(filename.length,28);
 const ending=Buffer.alloc(22);ending.writeUInt32LE(0x06054b50);ending.writeUInt16LE(1,8);ending.writeUInt16LE(1,10);ending.writeUInt32LE(central.length+filename.length,12);ending.writeUInt32LE(local.length+filename.length+payload.length+descriptor.length,16);
 return Buffer.concat([local,filename,payload,descriptor,central,filename,ending]);
}
export function pinArtifactFixture(github:any,check:any,run:any){
 const summary=JSON.parse(check.output.summary),receipt=receiptFor(summary,run.id,summary.mergeParents??[summary.baseSha,summary.headSha]);
 summary.requestDigest=receipt.requestDigest;check.output.summary=JSON.stringify(summary);
 const bytes=receiptZip(receipt);github.rest.actions.downloadArtifact=artifactDownloadApi(bytes);return receipt;
}
export function artifactDownloadApi(bytes:Buffer){return async(args:any)=>{
 const original=globalThis.fetch,endpoint=`https://api.github.com/repos/${args.owner}/${args.repo}/actions/artifacts/${args.artifact_id}/zip`;
 globalThis.fetch=async input=>String(input)===endpoint?new Response(null,{status:302,headers:{location:'https://productionresultssa6.blob.core.windows.net/actions-results/fixed'}}):new Response(bytes);
 try{return {data:await args.request.fetch(endpoint,{})};}finally{globalThis.fetch=original;}
};}
