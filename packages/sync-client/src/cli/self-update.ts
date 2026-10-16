import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, link, lstat, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const RELEASES = 'https://api.github.com/repos/HamedMP/matrix-os/releases?per_page=50';
const DOWNLOADS = 'https://github.com/HamedMP/matrix-os/releases/download/';
const STABLE = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const execute = promisify(execFile);
export interface CliRelease { version: string; assets: Array<{name: string; browser_download_url: string}> }

export function compareCliVersions(a: string, b: string): number {
  if (!STABLE.test(a) || !STABLE.test(b)) throw new Error('Invalid CLI version');
  const left=a.split('.').map(Number),right=b.split('.').map(Number);
  for(let i=0;i<3;i++){if(left[i]!==right[i])return left[i]!>right[i]!?1:-1;}
  return 0;
}

async function bytes(response: Response, limit: number): Promise<Buffer> {
  if(!response.ok||!response.body)throw new Error('CLI download unavailable');
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>limit){await response.body.cancel();throw new Error('CLI download too large');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let count=0;
  try {for(;;){const next=await reader.read();if(next.done)break;count+=next.value.byteLength;if(count>limit)throw new Error('CLI download too large');chunks.push(next.value);}}
  finally {await reader.cancel();}
  return Buffer.concat(chunks,count);
}

export async function latestCliRelease(fetcher: typeof fetch=fetch): Promise<CliRelease> {
  const response=await fetcher(RELEASES,{redirect:'error',signal:AbortSignal.timeout(10000),headers:{accept:'application/vnd.github+json'}});
  const data:unknown=JSON.parse((await bytes(response,1024*1024)).toString('utf8'));
  if(!Array.isArray(data)||data.length>50)throw new Error('CLI release unavailable');
  const releases:CliRelease[]=[];
  for(const value of data){
    if(!value||typeof value!=='object'||value.draft!==false||value.prerelease!==false||typeof value.tag_name!=='string'||!value.tag_name.startsWith('cli-v'))continue;
    const version=value.tag_name.slice(5);
    if(!STABLE.test(version)||!Array.isArray(value.assets)||value.assets.length>32)continue;
    const assets=value.assets.filter((asset:unknown):asset is CliRelease['assets'][number]=>Boolean(asset&&typeof asset==='object'&&'name'in asset&&typeof asset.name==='string'&&asset.name.length<160&&'browser_download_url'in asset&&typeof asset.browser_download_url==='string'&&asset.browser_download_url.length<512));
    releases.push({version,assets});
  }
  releases.sort((a,b)=>compareCliVersions(b.version,a.version));
  if(!releases[0])throw new Error('CLI release unavailable');
  return releases[0];
}

async function download(fetcher:typeof fetch,url:string,limit:number):Promise<Buffer>{
  // GitHub release redirects are restricted to the official asset infrastructure.
  let current=url;const signal=AbortSignal.timeout(180000);
  for(let hop=0;hop<5;hop++){
    const response=await fetcher(current,{redirect:'manual',signal});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get('location');await response.body?.cancel();
      if(!location)throw new Error('CLI download unavailable');
      const next=new URL(location,current);
      if(next.protocol!=='https:'||next.username||next.password||next.port||!['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(next.hostname))throw new Error('Untrusted CLI download');
      current=next.href;continue;
    }
    return bytes(response,limit);
  }
  throw new Error('CLI download unavailable');
}

async function verify(executable:string,version:string){
  const r=await execute(executable,['--version'],{timeout:15000,maxBuffer:8192,env:{...process.env,MATRIX_NO_TELEMETRY:'1'}});
  if(r.stdout.trim()!==version)throw new Error('CLI version verification failed');
}

export async function updateStandaloneCli(input:{executable:string;release:CliRelease;platform:string;arch:string;fetch?:typeof fetch}):Promise<void>{
  const {executable,release,platform,arch}=input,fetcher=input.fetch??fetch;
  if(!['linux','darwin'].includes(platform)||!['arm64','x64'].includes(arch)||!STABLE.test(release.version))throw new Error('Unsupported CLI installation');
  const asset=`matrix-${release.version}-${platform}-${arch}`,base=`${DOWNLOADS}cli-v${release.version}/`;
  for(const name of [asset,asset+'.sha256']){const entries=release.assets.filter(a=>a.name===name);if(entries.length!==1||entries[0]?.browser_download_url!==base+name)throw new Error('Untrusted CLI download');}
  const before=await lstat(executable);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1)throw new Error('Unsupported CLI installation');
  const parent=dirname(executable);await access(parent,constants.W_OK);
  const lock=join(parent,'.matrix-update.lock'),nonce=randomUUID(),candidate=join(parent,'.matrix-update-'+nonce),backup=join(parent,'.matrix-rollback-'+nonce);
  const guard=await open(lock,'wx',0o600);let saved=false,preserveBackup=false;
  try{
    const checksum=(await download(fetcher,base+asset+'.sha256',4096)).toString('utf8').trim().split(/\s+/);
    if(checksum.length!==2||!/^[a-f0-9]{64}$/.test(checksum[0]!)||checksum[1]!==asset)throw new Error('Invalid CLI checksum');
    const binary=await download(fetcher,base+asset,128*1024*1024);
    if(createHash('sha256').update(binary).digest('hex')!==checksum[0])throw new Error('CLI checksum mismatch');
    const file=await open(candidate,'wx',0o600);
    try{await file.writeFile(binary);await file.sync();}finally{await file.close();}
    await chmod(candidate,before.mode&0o777);await verify(candidate,release.version);
    const current=await lstat(executable);
    if(current.ino!==before.ino||current.dev!==before.dev||current.size!==before.size||current.mtimeMs!==before.mtimeMs||current.ctimeMs!==before.ctimeMs)throw new Error('CLI changed during update');
    await link(executable,backup);saved=true;
    await rename(candidate,executable);preserveBackup=true;
    try{await verify(executable,release.version);preserveBackup=false;}catch(error:unknown){
      // Refuse rollback over somebody else's replacement.
      const current=await readFile(executable);
      if(createHash('sha256').update(current).digest('hex')!==checksum[0]){preserveBackup=true;throw new Error('CLI changed during verification; rollback retained');}
      await rename(backup,executable);saved=false;preserveBackup=false;throw error;
    }
  }finally{
    await guard.close();
    await rm(candidate,{force:true});
    if(saved&&!preserveBackup)await rm(backup);
    await rm(lock);
  }
}
