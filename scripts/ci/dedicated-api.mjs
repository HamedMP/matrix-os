// ETags are authenticated freshness proofs, never offline/cache-error fallbacks.
// Each wrapper is bound to one immutable GitHub authentication/job context.
const bounded=(value,maximum)=>Number.isSafeInteger(value)&&value>0&&value<=maximum;
const sleep=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new Error('Controller API cycle cancelled'));};const timer=setTimeout(()=>{signal?.removeEventListener('abort',abort);resolve();},ms);signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();});
export function createConditionalGithub(source,options={}){
 const context=options.authenticationContext;
 if(typeof context!=='string'||!context||context.length>256)throw new Error('Invalid conditional API authentication context');
 const cap=options.maxEntries??32,byteCap=options.maxBytes??8*1024*1024,ttl=options.ttlMilliseconds??300000;
 if(!bounded(cap,64)||!bounded(byteCap,8*1024*1024)||!bounded(ttl,300000))throw new Error('Invalid conditional API cache bounds');
 const entries=new Map();let bytes=0,unconditional=false;
 const stats={requests:0,charged200:0,conditionalHits:0,errors:0,minimumRemaining:null,maximumPollIntervalSeconds:0};
 const drop=key=>{const value=entries.get(key);if(value){bytes-=value.bytes;entries.delete(key);}};
 const sweep=()=>{for(const [key,value]of entries)if(Date.now()-value.storedAt>=ttl)drop(key);};
 const metrics=()=>({...stats,cacheEntries:entries.size,cacheBytes:bytes});
 const read=async(namespace,method,args)=>{
  if(options.signal?.aborted)throw new Error('Controller API cycle cancelled');
  sweep();const key=JSON.stringify([context,namespace,method,args]);let cached=entries.get(key);
  if(cached&&cached.pollSeconds){const delay=cached.checkedAt+cached.pollSeconds*1000-Date.now();if(delay>0)await sleep(delay,options.signal);sweep();cached=entries.get(key);}
  if(options.signal?.aborted)throw new Error('Controller API cycle cancelled');
  const headers={...args.headers};if(cached?.etag&&!unconditional)headers['if-none-match']=cached.etag;
  const parameters={...args,...(Object.keys(headers).length?{headers}:{}),...(options.signal?{request:{...args.request,signal:options.signal}}:{})};
  stats.requests++;let response;
  try{response=await source.rest[namespace][method](parameters);}
  catch(error){if(error?.status===304&&error.response)response=error.response;else{stats.errors++;drop(key);throw error;}}
  const status=response.status??200,values=response.headers??{};
  const poll=values['x-poll-interval']===undefined?0:Number(values['x-poll-interval']);
  if(!Number.isSafeInteger(poll)||poll<0||poll>60){drop(key);throw new Error('GitHub poll interval exceeds reviewed lease policy');}
  stats.maximumPollIntervalSeconds=Math.max(stats.maximumPollIntervalSeconds,poll);
  if(values['x-ratelimit-remaining']!==undefined){const remaining=Number(values['x-ratelimit-remaining']);if(Number.isSafeInteger(remaining)&&remaining>=0)stats.minimumRemaining=stats.minimumRemaining===null?remaining:Math.min(stats.minimumRemaining,remaining);}
  if(status===304){
   if(!cached?.etag||unconditional||headers['if-none-match']!==cached.etag||values.etag!==cached.etag||response.url!==cached.url){stats.errors++;drop(key);throw new Error('Unbound authenticated 304 representation');}
   cached.checkedAt=Date.now();cached.pollSeconds=poll||cached.pollSeconds;entries.delete(key);entries.set(key,cached);stats.conditionalHits++;
   return{status:200,headers:values,url:cached.url,data:structuredClone(cached.data)};
  }
  if(status!==200){stats.errors++;drop(key);throw new Error('GitHub conditional API request failed');}
  stats.charged200++;
  const etag=values.etag,url=response.url;
  drop(key);
  if(typeof etag==='string'&&etag.length>0&&etag.length<=512&&!/[\r\n]/.test(etag)&&typeof url==='string'&&url.startsWith('https://api.github.com/')){
   const size=Buffer.byteLength(JSON.stringify(response.data));
   if(size<=byteCap){while(entries.size>=cap||bytes+size>byteCap)drop(entries.keys().next().value);entries.set(key,{etag,url,data:structuredClone(response.data),bytes:size,storedAt:Date.now(),checkedAt:Date.now(),pollSeconds:poll});bytes+=size;}
  }
  if(!entries.has(key)&&poll){while(entries.size>=cap)drop(entries.keys().next().value);entries.set(key,{bytes:0,storedAt:Date.now(),checkedAt:Date.now(),pollSeconds:poll});}
  return response;
 };
 const rest=Object.fromEntries(Object.entries(source.rest).map(([namespace,methods])=>[namespace,new Proxy(methods,{get(target,method){const fn=target[method];if(typeof fn!=='function')return fn;return /^(get|list|compare)/.test(String(method))?(args={})=>read(namespace,method,args):fn.bind(target);}})]));
 return{github:{...source,rest},metrics,runUnconditional:async callback=>{if(unconditional)throw new Error('Concurrent unconditional API cycle');unconditional=true;try{return await callback();}finally{unconditional=false;}}};
}

export async function readReviewedConfiguration(github,repo){
 const {data}=await github.rest.actions.listRepoVariables({...repo,per_page:100,page:1,request:{timeout:10000}});
 if(!Number.isSafeInteger(data?.total_count)||data.total_count<0||data.total_count>100||!Array.isArray(data.variables)||data.variables.length!==data.total_count)throw new Error('Reviewed variable list exceeds bounded coverage');
 const names=['MATRIX_CI_CONTROLLER_SHA','MATRIX_CI_DEDICATED_ENABLED','MATRIX_CI_DEDICATED_SHADOW','MATRIX_CI_RUNNER_IMAGE_DIGEST','MATRIX_CI_RUNNER_HARNESS_DIGEST'];
 const values={};
 for(const variable of data.variables){if(!names.includes(variable.name))continue;if(Object.hasOwn(values,variable.name))throw new Error('Duplicate reviewed configuration variable');if(typeof variable.value!=='string'||variable.value.length>256)throw new Error('Invalid reviewed configuration value');values[variable.name]=variable.value;}
 return values;
}
