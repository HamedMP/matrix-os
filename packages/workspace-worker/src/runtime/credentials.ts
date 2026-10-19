import { normalizeMatrixGatewayAuthority, type MatrixGatewayAuthority } from './matrix-gateway-authority.js';
/** Secrets are supplied by a server authority for one owner and runtime generation. */
export interface RuntimeCredentialScope { ownerId:string; generation:number }
export interface RuntimeCredentials extends RuntimeCredentialScope {
  databaseUrl:string;
  inferenceKey?:string;
  matrixGateway?:MatrixGatewayAuthority;
  authToken:string;
  expiresAt:number;
}
export type RuntimeCredentialResolver = (request:RuntimeCredentialScope & {signal:AbortSignal}) => Promise<unknown>;
export interface PreviewCredentialEnvironment {
  PREVIEW_ENABLED?:string;
  PREVIEW_OWNER_ID?:string;
  ANTHROPIC_API_KEY?:string;
  RUNTIME_AUTH_SECRET?:string;
  RUNTIME_DATABASE_URL?:string;
  RUNTIME_INFERENCE_MODE?:string;
  RUNTIME_MAX_RUN_MS?:string;
  MATRIX_MACHINE_ID?:string;
  MATRIX_HANDLE?:string;
  MATRIX_RUNTIME_SLOT?:string;
  MATRIX_FUNDED_AI_PLATFORM_URL?:string;
  MATRIX_FUNDED_AI_RELAY_URL?:string;
  MATRIX_FUNDED_AI_RUNTIME_TOKEN?:string;
}
const unavailable=()=>new Error('Runtime credentials unavailable');
const validScope=(scope:RuntimeCredentialScope)=>/^[A-Za-z0-9_-]{1,160}$/.test(scope.ownerId)
  && Number.isSafeInteger(scope.generation) && scope.generation>0;
const secret=(value:unknown):value is string=>typeof value==='string' && value.length>=6 && value.length<=8192 && !/[\u0000-\u001f\u007f]/.test(value);
const MAX_LIFETIME_MS=30*60_000;

/** Bound even a faulty broker that ignores AbortSignal; never propagate its raw error. */
export async function resolveRuntimeCredentials(resolver:RuntimeCredentialResolver|undefined,
  scope:RuntimeCredentialScope, now:()=>number=Date.now):Promise<RuntimeCredentials> {
  if (!resolver || !validScope(scope)) throw unavailable();
  const controller=new AbortController();
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(unavailable());},10_000);});
    const value=await Promise.race([Promise.resolve().then(()=>resolver({...scope,signal:controller.signal})),timeout]);
    if (!value || typeof value!=='object') throw unavailable();
    const result=value as Partial<RuntimeCredentials>;
    const timestamp=now();
    if (result.ownerId!==scope.ownerId || result.generation!==scope.generation
      || !Number.isSafeInteger(result.expiresAt) || result.expiresAt!<=timestamp || result.expiresAt!>timestamp+MAX_LIFETIME_MS
      || !secret(result.databaseUrl) || !secret(result.authToken)) throw unavailable();
    const database=new URL(result.databaseUrl);
    if (!['postgres:','postgresql:'].includes(database.protocol) || !database.hostname || !database.username || database.pathname.length<2) throw unavailable();
    const matrixGateway=result.matrixGateway===undefined ? undefined : normalizeMatrixGatewayAuthority(result.matrixGateway,scope.ownerId);
    if (matrixGateway ? result.inferenceKey!==undefined : !secret(result.inferenceKey)) throw unavailable();
    return {ownerId:scope.ownerId,generation:scope.generation,databaseUrl:result.databaseUrl,
      ...(matrixGateway ? {matrixGateway} : {inferenceKey:result.inferenceKey}),authToken:result.authToken,expiresAt:result.expiresAt!};
  } catch (error:unknown) {
    // A broker can include secret material in any failure shape. Fail closed
    // uniformly rather than turning lookup failures into missing-owner results.
    void error;
    throw unavailable();
  }
  finally {if(timer!==undefined) clearTimeout(timer);}
}

/** Isolated compatibility adapter. Production must inject its own owner broker. */
export function createPreviewCredentialResolver(env:PreviewCredentialEnvironment,now:()=>number=Date.now):RuntimeCredentialResolver {
  return async ({ownerId,generation,signal})=>{
    if (signal.aborted || env.PREVIEW_ENABLED!=='1' || ownerId!==env.PREVIEW_OWNER_ID
      || !validScope({ownerId,generation}) || !env.RUNTIME_AUTH_SECRET || !env.RUNTIME_DATABASE_URL) throw unavailable();
    const mode=env.RUNTIME_INFERENCE_MODE ?? 'anthropic';
    if (!['anthropic','matrix-gateway'].includes(mode) || (mode==='anthropic' && !env.ANTHROPIC_API_KEY)) throw unavailable();
    const matrixGateway=mode==='matrix-gateway' ? normalizeMatrixGatewayAuthority({ownerId,
      machineId:env.MATRIX_MACHINE_ID,handle:env.MATRIX_HANDLE,runtimeSlot:env.MATRIX_RUNTIME_SLOT,
      platformOrigin:env.MATRIX_FUNDED_AI_PLATFORM_URL,relayOrigin:env.MATRIX_FUNDED_AI_RELAY_URL,
      runtimeToken:env.MATRIX_FUNDED_AI_RUNTIME_TOKEN,maxRunMs:Number(env.RUNTIME_MAX_RUN_MS ?? 300_000)},ownerId) : undefined;
    const encoder=new TextEncoder();
    const key=await crypto.subtle.importKey('raw',encoder.encode(env.RUNTIME_AUTH_SECRET),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const signed=await crypto.subtle.sign('HMAC',key,encoder.encode(`${ownerId}:${generation}`));
    const authToken=Array.from(new Uint8Array(signed),byte=>byte.toString(16).padStart(2,'0')).join('');
    return {ownerId,generation,databaseUrl:env.RUNTIME_DATABASE_URL,
      ...(matrixGateway ? {matrixGateway} : {inferenceKey:env.ANTHROPIC_API_KEY}),
      authToken,expiresAt:now()+MAX_LIFETIME_MS};
  };
}
