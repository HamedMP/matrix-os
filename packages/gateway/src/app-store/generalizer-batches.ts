import {encodeAppBundle} from '@matrix-os/contracts/app-store-bundle';
export const GENERALIZATION_LIMITS=Object.freeze({fileJsonBytes:48*1024,batchJsonBytes:48*1024,promptBytes:256*1024,maxCalls:16,totalMs:180_000,instructionBytes:4096,newFiles:8,newFileJsonBytes:16*1024,newFilesTotalBytes:64*1024});
/** Public callers may map this safe reason to limits_exceeded and explain source splitting. */
export class StoreGeneralizationLimitError extends Error{
 constructor(readonly reason:'file_size'|'batch_count'|'context_size'|'instructions_size'|'new_files'){super('Split large text files, reduce draft size or shorten revision instructions before retrying.');this.name='StoreGeneralizationLimitError';}
}
export interface GeneralizationTextFile{path:string;contents:string}
export function sourceText(bytes:Buffer):string|null{
 if(bytes.includes(0))return null;try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch(error:unknown){if(error instanceof TypeError)return null;throw error;}
}
export function generalizationBatches(files:ReadonlyMap<string,Buffer>,instructions:string):GeneralizationTextFile[][]{
 encodeAppBundle('source',files);if(Buffer.byteLength(instructions)>GENERALIZATION_LIMITS.instructionBytes)throw new StoreGeneralizationLimitError('instructions_size');
 const batches:GeneralizationTextFile[][]=[];let batch:GeneralizationTextFile[]=[];let size=2;
 // Manifest is shared in every prompt; the remaining original text appears in exactly one batch.
 for(const[path,bytes]of files){if(path==='pnpm-lock.yaml'||path==='matrix.json')continue;const contents=sourceText(bytes);if(contents===null)continue;const entry={path,contents};const length=Buffer.byteLength(JSON.stringify(entry));if(length>GENERALIZATION_LIMITS.fileJsonBytes)throw new StoreGeneralizationLimitError('file_size');
  if(batch.length&&size+length+1>GENERALIZATION_LIMITS.batchJsonBytes){batches.push(batch);batch=[];size=2;}batch.push(entry);size+=length+1;
 }
 if(batch.length||!batches.length)batches.push(batch);
 if(batches.length>GENERALIZATION_LIMITS.maxCalls)throw new StoreGeneralizationLimitError('batch_count');
 const manifest=files.get('matrix.json');if(manifest&&Buffer.byteLength(JSON.stringify({path:'matrix.json',contents:sourceText(manifest)}))>GENERALIZATION_LIMITS.fileJsonBytes)throw new StoreGeneralizationLimitError('file_size');
 return batches;
}
export function generalizationFileIndex(files:ReadonlyMap<string,Buffer>){return [...files].map(([path,bytes])=>({path,bytes:bytes.length,kind:path==='pnpm-lock.yaml'?'lockfile':sourceText(bytes)===null?'binary':'text'}));}
