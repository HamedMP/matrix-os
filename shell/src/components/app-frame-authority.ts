export const OWNER_IFRAME_SANDBOX='allow-scripts allow-forms allow-popups allow-downloads';
export function isCurrentAppFrame(event:MessageEvent,expected:{source:MessageEventSource|null;app:string;token:string}):boolean{
 return event.source===expected.source&&(event.origin==='null'||event.origin===globalThis.location?.origin)&&event.data?.app===expected.app&&Boolean(expected.token)&&event.data.bridgeToken===expected.token;
}
export const communityDocumentPolicy="form-action 'none'; frame-src 'none'; object-src 'none'";
export function communityIframeSandbox(community:boolean):string{return community?'allow-scripts':OWNER_IFRAME_SANDBOX;}
