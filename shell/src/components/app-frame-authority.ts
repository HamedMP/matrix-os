export const OWNER_IFRAME_SANDBOX='allow-scripts allow-forms allow-popups allow-downloads';
export function isCurrentAppFrame(event:MessageEvent,expected:{source:MessageEventSource|null;app:string;token:string}):boolean{
 return event.source===expected.source&&(event.origin==='null'||event.origin===globalThis.location?.origin)&&event.data?.app===expected.app&&Boolean(expected.token)&&event.data.bridgeToken===expected.token;
}
export function communityDocumentPolicy(baseHref:string):string{
 const base=new URL(baseHref,globalThis.location?.href??'https://app.matrix-os.com/');
 if(!['https:','http:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/'))throw new Error('Invalid app asset base');
 const assets=base.href;
 return [`default-src 'none'`,`base-uri ${assets}`,`object-src 'none'`,`script-src ${assets} 'unsafe-inline'`,`worker-src ${assets}`,`style-src ${assets} 'unsafe-inline'`,`img-src ${assets} data: blob:`,`font-src ${assets} data:`,`connect-src 'none'`,`form-action 'none'`,`frame-src 'none'`].join('; ');
}
export function communityIframeSandbox(community:boolean):string{return community?'allow-scripts':OWNER_IFRAME_SANDBOX;}
