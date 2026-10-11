// Read authenticated immutable artifact bytes; never extract or execute them.
import {createHash} from 'node:crypto';
import {inflateRawSync} from 'node:zlib';
const MAX=16384;
class ReceiptArchiveError extends Error {}
const bad=()=>{throw new ReceiptArchiveError('Controller receipt archive rejected');};
function rejectCaught(stage,error,expected,message){
 const errorKind=error instanceof Error&&expected(error)?'invalid-input':'unexpected-error';
 // Never include receipt bytes, signed URLs, credentials or raw exception text.
 console.warn('Controller artifact rejected',{stage,errorKind});
 throw new Error(message);
}
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function extras(bytes){for(let offset=0;offset<bytes.length;){if(offset+4>bytes.length||bytes.readUInt16LE(offset)===1)bad();const size=bytes.readUInt16LE(offset+2);offset+=4+size;if(offset>bytes.length)bad();}}
export function decodeReceiptArchive(input){
 const zip=Buffer.from(input);if(zip.length<22||zip.length>MAX)bad();
 const end=zip.length-22;
 if(zip.readUInt32LE(end)!==0x06054b50||zip.readUInt16LE(end+4)!==0||zip.readUInt16LE(end+6)!==0||zip.readUInt16LE(end+8)!==1||zip.readUInt16LE(end+10)!==1||zip.readUInt16LE(end+20)!==0)bad();
 const directory=zip.readUInt32LE(end+16),directorySize=zip.readUInt32LE(end+12);
 if(directory+directorySize!==end||directorySize<46||directory<30||zip.readUInt32LE(directory)!==0x02014b50)bad();
 const flags=zip.readUInt16LE(directory+8),method=zip.readUInt16LE(directory+10),crc=zip.readUInt32LE(directory+16),compressed=zip.readUInt32LE(directory+20),expanded=zip.readUInt32LE(directory+24);
 const nameSize=zip.readUInt16LE(directory+28),extraSize=zip.readUInt16LE(directory+30),commentSize=zip.readUInt16LE(directory+32),mode=zip.readUInt32LE(directory+38)>>>16;
 if(flags&~0x808||![0,8].includes(method)||expanded<1||expanded>MAX||compressed<1||compressed>MAX||nameSize!==12||extraSize>1024||commentSize!==0||zip.readUInt16LE(directory+34)!==0||zip.readUInt32LE(directory+42)!==0||(mode&0xf000)&&((mode&0xf000)!==0x8000)||directorySize!==46+nameSize+extraSize)bad();
 if(zip.subarray(directory+46,directory+46+nameSize).toString('utf8')!=='receipt.json')bad();extras(zip.subarray(directory+46+nameSize,end));
 if(zip.readUInt32LE(0)!==0x04034b50||zip.readUInt16LE(6)!==flags||zip.readUInt16LE(8)!==method||zip.readUInt16LE(26)!==nameSize)bad();
 const localExtra=zip.readUInt16LE(28),start=30+nameSize+localExtra,finish=start+compressed;
 if(localExtra>1024||finish>directory||zip.subarray(30,30+nameSize).toString('utf8')!=='receipt.json')bad();extras(zip.subarray(30+nameSize,start));
 if(flags&8){
  const descriptor=directory-finish;if(![12,16].includes(descriptor))bad();const offset=finish+(descriptor===16?4:0);
  if(descriptor===16&&zip.readUInt32LE(finish)!==0x08074b50)bad();
  if(zip.readUInt32LE(offset)!==crc||zip.readUInt32LE(offset+4)!==compressed||zip.readUInt32LE(offset+8)!==expanded)bad();
  for(const [offset,wanted]of [[14,crc],[18,compressed],[22,expanded]])if(![0,wanted].includes(zip.readUInt32LE(offset)))bad();
 }else if(finish!==directory||zip.readUInt32LE(14)!==crc||zip.readUInt32LE(18)!==compressed||zip.readUInt32LE(22)!==expanded)bad();
 let bytes;try{if(method===0)bytes=zip.subarray(start,finish);else{const result=inflateRawSync(zip.subarray(start,finish),{maxOutputLength:MAX,info:true});if(result.engine.bytesWritten!==compressed)bad();bytes=result.buffer;}}catch(error){rejectCaught('expansion',error,value=>value instanceof ReceiptArchiveError||['Z_DATA_ERROR','Z_BUF_ERROR','ERR_BUFFER_TOO_LARGE'].includes(value.code),'Bounded controller receipt expansion rejected');}
 if(bytes.length!==expanded||crc32(bytes)!==crc)bad();
 try{const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!value||Array.isArray(value)||typeof value!=='object')bad();return value;}catch(error){rejectCaught('json',error,value=>value instanceof SyntaxError||value instanceof ReceiptArchiveError||(value instanceof TypeError&&value.code==='ERR_ENCODING_INVALID_ENCODED_DATA'),'Controller receipt JSON rejected');}
}
function signedLocation(value){
 let url;try{url=new URL(value);}catch(error){rejectCaught('redirect',error,value=>value instanceof TypeError&&value.code==='ERR_INVALID_URL','Controller artifact redirect rejected');}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||!/^productionresultssa[a-z0-9]*\.blob\.core\.windows\.net$/.test(url.hostname)||url.href.length>8192)throw new Error('Controller artifact redirect rejected');
 return url;
}
async function boundedBody(response){
 const length=response.headers.get('content-length');if(length!==null&&(!/^[0-9]+$/.test(length)||Number(length)>MAX))bad();
 if(!response.ok||!response.body)bad();const reader=response.body.getReader(),parts=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX)bad();parts.push(Buffer.from(value));}return Buffer.concat(parts,size);}
 finally{await reader.cancel();reader.releaseLock();}
}
export async function downloadControllerReceipt(github,repo,artifact){
 if(`${repo.owner}/${repo.repo}`.toLowerCase()!=='hamedmp/matrix-os'||!Number.isSafeInteger(artifact.id)||artifact.id<1||artifact.expired||!Number.isSafeInteger(artifact.size_in_bytes)||artifact.size_in_bytes<1||artifact.size_in_bytes>MAX)bad();
 let archive;
 const signal=AbortSignal.timeout(30000),endpoint=`https://api.github.com/repos/${repo.owner}/${repo.repo}/actions/artifacts/${artifact.id}/zip`;
 await github.rest.actions.downloadArtifact({...repo,artifact_id:artifact.id,archive_format:'zip',request:{timeout:10000,signal,fetch:async(url,init)=>{
  if(String(url)!==endpoint)throw new Error('Unexpected controller artifact API endpoint');
  const api=await fetch(url,{...init,redirect:'manual',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])});
  let location;try{if(api.status!==302)throw new Error('Authenticated artifact download redirect unavailable');location=signedLocation(api.headers.get('location'));}finally{await api.body?.cancel();}
  archive=await boundedBody(await fetch(location,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(10000)])}));
  // The Octokit parser need not retain the archive a second time.
  return new Response('{}',{status:200,headers:{'content-type':'application/json'}});
 }}});
 // Unsupported clients cannot bypass the bounded authenticated download adapter.
 if(!archive)bad();
 if(archive.length>MAX)bad();
 if(artifact.digest!==undefined&&artifact.digest!==`sha256:${createHash('sha256').update(archive).digest('hex')}`)throw new Error('Controller artifact digest mismatch');
 return decodeReceiptArchive(archive);
}
