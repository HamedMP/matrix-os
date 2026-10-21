const PREFIX='Workspace execution interrupted: ';
const phases=new Set(['start','restore','hydrate','execute','stop','export','checkpoint','checkpoint-publish','publish','lifecycle']);
type Diagnostic={phase:string;name:string;code?:string;detail?:string};
const identifier=(value:unknown):string|undefined => typeof value==='string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;

/** Tagged, sanitized server diagnostics survive Durable Object RPC Error serialization. */
export function runtimeDiagnostic(phase:string,error:unknown,redact:(text:string)=>string):Error {
  if (safeRuntimeDiagnostic(error).phase!=='unknown') return new Error((error as Error).message);
  const value=error as {name?:unknown;code?:unknown;message?:unknown};
  const diagnostic:Diagnostic={phase:phases.has(phase)?phase:'lifecycle',name:identifier(value?.name)??'Error'};
  const code=identifier(value?.code); if(code) diagnostic.code=code;
  if(typeof value?.message==='string') diagnostic.detail=redact(value.message).slice(-2048);
  return new Error(PREFIX+JSON.stringify(diagnostic));
}

/** Never log raw, untagged errors at the Queue boundary. This is not a client error. */
export function safeRuntimeDiagnostic(error:unknown):Diagnostic {
  if(error instanceof Error && error.message.startsWith(PREFIX) && error.message.length<4096) {
    try {
      const value=JSON.parse(error.message.slice(PREFIX.length));
      if(phases.has(value?.phase) && identifier(value.name) && (value.detail===undefined || typeof value.detail==='string' && value.detail.length<=2048)) {
        return {phase:value.phase,name:value.name,...identifier(value.code)?{code:value.code}:{},...typeof value.detail==='string'?{detail:value.detail}:{}};
      }
    } catch(error:unknown) { if(!(error instanceof SyntaxError)) throw error; }
  }
  return {phase:'unknown',name:'Error'};
}
