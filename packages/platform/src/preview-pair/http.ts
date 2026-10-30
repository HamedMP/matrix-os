export class PreviewPairUpstreamError extends Error {
  constructor() { super("Preview upstream is unavailable"); this.name="PreviewPairUpstreamError"; }
}
export async function readPreviewPairBytes(response: Response, maximum: number): Promise<Uint8Array> {
  if(!response.ok||!response.body) throw new PreviewPairUpstreamError();
  const reader=response.body.getReader(), chunks: Uint8Array[]=[];
  let size=0;
  try {
    for(;;) { const {value,done}=await reader.read(); if(done)break;
      size+=value.byteLength;
      if(size>maximum){await reader.cancel();throw new PreviewPairUpstreamError();}
      chunks.push(value);
    }
  } finally {reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return bytes;
}
export async function readPreviewPairJson(response: Response, maximum=1024*1024): Promise<unknown> {
  try {return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(await readPreviewPairBytes(response,maximum)));}
  catch(error:unknown){if(error instanceof PreviewPairUpstreamError)throw error;throw new PreviewPairUpstreamError();}
}
