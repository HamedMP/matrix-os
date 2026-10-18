/** Trusted deployment configuration only. Request Host/Forwarded headers never define app authority. */
export function communityRuntimeCsp(slug:string,config:{origin?:string;handle?:string}={}):string{
 if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug))throw new Error('Invalid app identifier');
 const raw=config.origin??process.env.MATRIX_APP_STORE_PUBLIC_ORIGIN??'https://app.matrix-os.com';const origin=new URL(raw);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('Invalid public runtime origin');
 const handle=config.handle??process.env.MATRIX_HANDLE;if(handle&&!/^[a-z0-9][a-z0-9-]{0,63}$/.test(handle))throw new Error('Invalid runtime handle');
 const assets=[`${origin.origin}/apps/${slug}/`,...(handle?[`${origin.origin}/vm/${handle}/apps/${slug}/`]:[])].join(' ');
 return [`default-src 'none'`,`base-uri 'none'`,`object-src 'none'`,`script-src ${assets} 'unsafe-inline'`,`style-src ${assets} 'unsafe-inline'`,`img-src ${assets} data: blob:`,`font-src ${assets} data:`,`worker-src ${assets}`,`connect-src 'none'`,`form-action 'none'`,`frame-src 'none'`,`frame-ancestors ${origin.origin}`].join('; ');
}
