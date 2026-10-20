/** Main-process authority; renderer and app manifests cannot select their trust tier. */
export function createNativeAppTrustResolver(options:{getGatewayOrigin():string;getToken():string|null|undefined;fetchFn?:typeof fetch}){
 return async(identity:string):Promise<boolean>=>{
  const slug=identity.replace(/^apps\//,'');if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))return false;
  const token=options.getToken();if(!token)return false;
  const origin=new URL(options.getGatewayOrigin());if(!['https:','http:'].includes(origin.protocol))return false;
  const response=await (options.fetchFn??fetch)(new URL(`/api/apps/${slug}/manifest`,origin).toString(),{headers:{authorization:`Bearer ${token}`},redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok||Number(response.headers.get('content-length')??0)>32_768)return false;
  const reader=response.body?.getReader();if(!reader)return false;let text='';let count=0;
  try{while(true){const chunk=await reader.read();if(chunk.done)break;count+=chunk.value.byteLength;if(count>32768)return false;text+=new TextDecoder().decode(chunk.value);}}
  finally{await reader.cancel();reader.releaseLock();}
  const value:unknown=JSON.parse(text);return Boolean(value&&typeof value==='object'&&'distribution' in value&&value.distribution&&typeof value.distribution==='object'&&'trust'in value.distribution&&value.distribution.trust==='owner');
 };
}
