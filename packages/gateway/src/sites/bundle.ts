/** Collect only production artifacts. Never follow links or upload source trees. */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES: Record<string,string> = {'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.json':'application/json','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.gif':'image/gif','.ico':'image/x-icon','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.txt':'text/plain','.wasm':'application/wasm'};
export interface SiteFile { path: string; contentType: string; body: string }
export async function collectSiteFiles(appDir: string, output: string): Promise<SiteFile[]> {
 const root=resolve(appDir),dist=resolve(root,output);
 if(dist===root || !dist.startsWith(root+sep) || output.split(/[\\/]/).some(p=>p==='..'||p.startsWith('.'))) throw new Error('Unsafe public build output');
 const rel=relative(root,dist).split(sep);let candidate=root;
 for(const component of rel){candidate=join(candidate,component);if(!(await lstat(candidate)).isDirectory() || (await lstat(candidate)).isSymbolicLink()) throw new Error('Unsafe public build output');}
 if(!(await realpath(dist)).startsWith((await realpath(root))+sep)) throw new Error('Unsafe public build output');
 const files:SiteFile[]=[];let total=0,visited=0;
 async function walk(dir:string,prefix='',depth=0):Promise<void>{
  if(depth>16) throw new Error('Public build too large');
  for(const name of await readdir(dir)){
   if(++visited>1000 || name.startsWith('.') || /^(?:src|node_modules|env|secrets?|credentials?|matrix\.json|package(?:-lock)?\.json|pnpm-lock\.yaml)$/i.test(name) || /\.(?:map|env|sql|log|ts|tsx|jsx|pem|key)$/i.test(name) || /^(?:secrets?|credentials?|env|database|dump|backup)(?:[._-]|$)/i.test(name)) throw new Error('Unsafe public build artifact');
   const path=join(dir,name),info=await lstat(path),filePath=prefix+name;
   if(info.isSymbolicLink()) throw new Error('Unsafe public build artifact');
   if(info.isDirectory()){await walk(path,filePath+'/',depth+1);continue;}
   const contentType=TYPES[extname(name).toLowerCase()];
   if(!info.isFile() || !contentType || files.length>=200 || info.size>MAX_BYTES-total) throw new Error('Public build too large or unsupported');
   const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
   let bytes:Buffer;
   try{
    const current=await handle.stat();if(!current.isFile() || current.size>MAX_BYTES-total) throw new Error('Public build too large');
    const buffer=Buffer.alloc(current.size+1);let offset=0;
    while(offset<buffer.length){const read=await handle.read(buffer,offset,buffer.length-offset,null);if(!read.bytesRead)break;offset+=read.bytesRead;}
    if(offset>current.size) throw new Error('Public build changed during collection');bytes=buffer.subarray(0,offset);
   }finally{await handle.close();}
   total+=bytes.length;
   if(contentType==='text/javascript'&&/sourceMappingURL\s*=/.test(bytes.toString('utf8')))throw new Error('Unsafe public build artifact');
   if(contentType.startsWith('text/html') && /(?:src|href)\s*=\s*["']\/(?!\/)/i.test(bytes.toString('utf8'))) throw new Error('App needs a public build');
   // High-confidence credential patterns cannot be approved by publishing an asset.
   if((contentType.startsWith('text/') || contentType==='application/json') && /(?:sk-(?:ant-|proj-)[A-Za-z0-9_-]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|postgres(?:ql)?:\/\/[^\s"']+)/.test(bytes.toString('utf8'))) throw new Error('Unsafe public build artifact');
   files.push({path:filePath,contentType,body:bytes.toString('base64')});
  }
 }
 await walk(dist);if(!files.some(file=>file.path==='index.html'))throw new Error('Public build requires index.html');return files;
}
