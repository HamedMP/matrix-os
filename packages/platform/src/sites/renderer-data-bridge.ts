import { APP_BRIDGE_STORED_VALUE_PREFIX, SITE_PUBLIC_DATA_REQUEST_MAX_BYTES, type SiteRecord } from '@matrix-os/contracts';

/**
 * 2694: public-site visitors get the owner app bridge shape (`db.*`, `readData`/`writeData`,
 * unshared-owner `collaboration`). The opaque frame keeps `connect-src 'none'`; every call is a
 * fixed-type message to the Matrix-rendered parent, which calls `/<site>/data` on its own origin.
 * Returns object-literal members appended to the frozen `window.MatrixOS`.
 */
export function frameDataBridge(site: SiteRecord): string {
    if (site.accessMode !== 'public') return '';
    return `,...(()=>{
const appName=${JSON.stringify(site.appSlug)};const prefix=${JSON.stringify(APP_BRIDGE_STORED_VALUE_PREFIX)};
const listeners=[];let flights=0;
const coarse=error=>['Try again later','Invalid change'].includes(error)?error:'Shared data is unavailable';
const request=body=>new Promise((resolve,reject)=>{
 if(flights>=8){reject(Error('Try again later'));return}
 flights++;const channel=new MessageChannel();let timeout;
 const done=()=>{flights--;clearTimeout(timeout);channel.port1.close()};
 timeout=setTimeout(()=>{done();reject(Error('Shared data is unavailable'))},11000);
 channel.port1.onmessage=event=>{done();const reply=event.data;reply&&reply.ok?resolve(reply.result):reject(Error(coarse(reply&&reply.error)))};
 try{parent.postMessage({type:'matrix-site-data',request:body},'https://matrix.page',[channel.port2])}
 catch(error){done();console.warn('[MatrixOS site] data request unavailable',error instanceof Error?error.name:'UnknownError');reject(Error('Shared data is unavailable'))}
});
const subscribe=callback=>{
 if(typeof callback!=='function'||listeners.length>=32)throw Error('Shared data is unavailable');
 listeners.push(callback);return()=>{const index=listeners.indexOf(callback);if(index>=0)listeners.splice(index,1)};
};
const notify=key=>{for(const listener of listeners.slice()){try{listener(key,appName)}catch(error){console.warn('[MatrixOS site] change listener failed',error instanceof Error?error.name:'UnknownError')}}};
const db=action=>request({kind:'db',action});
const wrote=(table,pending)=>pending.then(result=>{if(!result||result.ok!==false)notify(table);return result});
const key=value=>{const safe=String(value).replace(/[^a-zA-Z0-9_-]/g,'');if(!safe||safe.length>128)throw Error('Invalid change');return safe};
const encode=value=>prefix+JSON.stringify(value===undefined?{undefined:true}:{value});
const decode=stored=>{
 if(typeof stored!=='string'||stored.indexOf(prefix)!==0)return stored;
 try{const envelope=JSON.parse(stored.slice(prefix.length));if(envelope&&typeof envelope==='object'){if(envelope.undefined===true)return undefined;if(Object.prototype.hasOwnProperty.call(envelope,'value'))return envelope.value}}
 catch(error){console.warn('[MatrixOS site] stored value could not be decoded',error instanceof Error?error.name:'UnknownError')}
 return stored;
};
const writes=['insert','bulkInsert','update','bulkUpdate','compareAndSwap','delete'];
const collaborate=(action,write)=>{
 if(!action||typeof action!=='object'||Array.isArray(action))return Promise.reject(Error('Collaboration unavailable'));
 const {app:ignored,...rest}=action;void ignored;
 if(write!==writes.includes(rest.action))return Promise.reject(Error('Collaboration unavailable'));
 const pending=db(rest).then(result=>rest.action==='count'&&result?result.count:result);
 return (write?wrote(rest.table,pending):pending).catch(error=>{console.warn('[MatrixOS site] collaboration request failed',error instanceof Error?error.message:'UnknownError');throw Error('Collaboration unavailable')});
};
const readData=value=>{try{return request({kind:'kvRead',key:key(value)}).then(result=>decode(result&&result.value))}catch(error){return Promise.reject(error)}};
const writeData=(value,data)=>{try{const safe=key(value);return request({kind:'kvWrite',key:safe,value:encode(data)}).then(()=>{notify(safe)})}catch(error){return Promise.reject(error)}};
return{
 app:Object.freeze({name:appName}),readData,writeData,onDataChange:subscribe,
 db:Object.freeze({
  find:(table,options)=>{const action={action:'find',table};if(options){if(options.where)action.filter=options.where;if(options.orderBy)action.orderBy=options.orderBy;if(options.limit)action.limit=options.limit;if(options.offset)action.offset=options.offset}return db(action)},
  findOne:(table,id)=>db({action:'findOne',table,id}),
  insert:(table,data)=>wrote(table,db({action:'insert',table,data})),
  bulkInsert:(table,rows)=>wrote(table,db({action:'bulkInsert',table,rows})),
  update:(table,id,data)=>wrote(table,db({action:'update',table,id,data})),
  bulkUpdate:(table,updates)=>wrote(table,db({action:'bulkUpdate',table,updates})),
  compareAndSwap:(table,id,expectedPayload,data)=>wrote(table,db({action:'compareAndSwap',table,id,expectedPayload,data})),
  delete:(table,id)=>wrote(table,db({action:'delete',table,id})),
  count:(table,filter)=>db(filter?{action:'count',table,filter}:{action:'count',table}).then(result=>result.count),
  appInfo:()=>db({action:'appInfo'}),
  onChange:(table,callback)=>subscribe(changed=>{if(changed===table)callback({table})}),
 }),
 collaboration:Object.freeze({
  participant:null,
  query:action=>collaborate(action,false).then(result=>({result,revision:'0'})),
  mutate:(action,expectedRevision)=>typeof expectedRevision==='string'&&/^(?:0|[1-9][0-9]{0,18})$/.test(expectedRevision)
   ?collaborate(action,true).then(result=>({result,revision:'0',replayed:false})):Promise.reject(Error('Collaboration unavailable')),
  onChange:callback=>{if(typeof callback!=='function')throw Error('Collaboration unavailable');return subscribe(()=>callback())},
 }),
};
})()`;
}

/** Parent-page relay for frame data messages; public sites only. */
export function pageDataHandler(site: SiteRecord): string {
    if (site.accessMode !== 'public') return '';
    return `let dataFlights=0;
const relayData=async(port,request)=>{
 if(!request||typeof request!=='object'||Array.isArray(request)){port.postMessage({error:'Invalid change'});port.close();return}
 if(dataFlights>=8){port.postMessage({error:'Try again later'});port.close();return}
 dataFlights++;
 try{const body=JSON.stringify(request);if(new TextEncoder().encode(body).length>${SITE_PUBLIC_DATA_REQUEST_MAX_BYTES}){port.postMessage({error:'Invalid change'});return}
 const response=await fetch('/${site.id}/data',{method:'POST',headers:{'Content-Type':'application/json'},body,credentials:'omit',redirect:'error',signal:AbortSignal.timeout(10000)});
 let reply=null;try{reply=await response.json()}catch(parseError){console.warn('[sites] data reply unreadable',parseError instanceof Error?parseError.name:'UnknownError')}
 port.postMessage(response.ok&&reply&&Object.prototype.hasOwnProperty.call(reply,'result')?{ok:true,result:reply.result}
  :{error:response.status===429?'Try again later':response.status===400||response.status===413?'Invalid change':'Shared data is unavailable'});
 }catch(error){console.warn('[sites] data request failed',error instanceof TypeError?'TypeError':error instanceof Error?'Error':'UnknownError');port.postMessage({error:'Shared data is unavailable'})}
 finally{dataFlights--;port.close()}
};`;
}
