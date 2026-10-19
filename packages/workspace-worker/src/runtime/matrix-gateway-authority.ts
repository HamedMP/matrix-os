/** Server-controlled identity of one owner-bound logical Starter runtime. */
export interface MatrixGatewayAuthority {
  ownerId:string;
  machineId:string;
  handle:string;
  runtimeSlot:string;
  platformOrigin:string;
  relayOrigin:string;
  runtimeToken:string;
  maxRunMs:number;
}
const unavailable=()=>new Error('Runtime credentials unavailable');
function origin(value:unknown):string {
  if (typeof value!=='string' || value.length>2048) throw unavailable();
  const url=new URL(value);
  if (url.protocol!=='https:' || url.username || url.password || url.port || url.pathname!=='/'
    || url.search || url.hash || value!==url.origin) throw unavailable();
  return value;
}
export function normalizeMatrixGatewayAuthority(value:unknown,ownerId:string):MatrixGatewayAuthority {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw unavailable();
  const input=value as Partial<MatrixGatewayAuthority>;
  if (input.ownerId!==ownerId || typeof input.machineId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(input.machineId)
    || typeof input.handle!=='string' || !/^swp-[1-9][0-9]{0,8}-[0-9a-f]{8}$/.test(input.handle)
    || input.runtimeSlot!==input.handle || typeof input.runtimeToken!=='string'
    || !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(input.runtimeToken)
    || !Number.isSafeInteger(input.maxRunMs) || input.maxRunMs!<60_000 || input.maxRunMs!>600_000) throw unavailable();
  return {ownerId,machineId:input.machineId,handle:input.handle,runtimeSlot:input.handle,
    platformOrigin:origin(input.platformOrigin),relayOrigin:origin(input.relayOrigin),runtimeToken:input.runtimeToken,maxRunMs:input.maxRunMs!};
}
