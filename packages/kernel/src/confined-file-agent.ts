import {validateBundlePath,APP_BUNDLE_LIMITS} from '@matrix-os/contracts/app-store-bundle';
import {generateAppText} from './app-ai.js';
export interface ConfinedTextEdit {path:string;contents:string|null}
/** Pure bounded patch; models receive text, never filesystem or network tools. */
export function applyConfinedFileEdits(original:ReadonlyMap<string,Buffer>,edits:readonly ConfinedTextEdit[]):Map<string,Buffer>{
 if(edits.length>128)throw new Error('Edit limit');const files=new Map(original);const seen=new Set<string>();
 for(const edit of edits){
  validateBundlePath(edit.path,'source');if(seen.has(edit.path))throw new Error('Duplicate edit');seen.add(edit.path);
  if(edit.contents===null)files.delete(edit.path);else{if(Buffer.byteLength(edit.contents)>APP_BUNDLE_LIMITS.maxFileBytes)throw new Error('Edit size limit');files.set(edit.path,Buffer.from(edit.contents));}
 }
 if(files.size>APP_BUNDLE_LIMITS.maxFiles||[...files.values()].reduce((n,b)=>n+b.length,0)>APP_BUNDLE_LIMITS.maxTotalBytes)throw new Error('Source size limit');return files;
}
/** Reuses the verified text-only SDK path: tools[], no MCP/settings/session, $0.25 budget. */
export async function runConfinedFileAgent(options:{prompt:string;env:Record<string,string|undefined>;signal:AbortSignal}):Promise<unknown>{
 if(Buffer.byteLength(options.prompt)>256*1024)throw new Error('Source prompt limit');
 const result=await generateAppText({prompt:options.prompt,model:'claude-haiku-4-5',env:options.env,signal:AbortSignal.any([options.signal,AbortSignal.timeout(60_000)])});
 return JSON.parse(result.text);
}
