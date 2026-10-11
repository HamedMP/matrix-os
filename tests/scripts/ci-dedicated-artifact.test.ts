import {expect,it,vi} from 'vitest';
import {decodeReceiptArchive,downloadControllerReceipt} from '../../scripts/ci/dedicated-artifact.mjs';
import {receiptZip,artifactDownloadApi} from './helpers/dedicated-artifact-fixture';
const repo={owner:'HamedMP',repo:'matrix-os'};
it('reads exactly one bounded JSON receipt without extracting or executing archive files',()=>{expect(decodeReceiptArchive(receiptZip({schemaVersion:1}))).toEqual({schemaVersion:1});});
it.each(['path','large','duplicate','directory','crc','truncated','symlink','trailing'])('rejects malformed archive %s',kind=>{
 let zip=receiptZip(kind==='large'?{x:'a'.repeat(20000)}:{schemaVersion:1},kind==='path'?'../receipt.json':kind==='directory'?'receipt.json/':'receipt.json');const central=zip.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));if(kind==='duplicate')zip.writeUInt16LE(2,zip.length-12);if(kind==='crc')zip[35]^=1;if(kind==='truncated')zip=zip.subarray(0,-1);if(kind==='symlink')zip.writeUInt32LE(0xa1ff0000,central+38);if(kind==='trailing')zip=Buffer.concat([zip,Buffer.from('x')]);
 expect(()=>decodeReceiptArchive(zip)).toThrow();
});
it('requires authenticated API metadata and bounds the received compressed bytes',async()=>{
 const github={rest:{actions:{downloadArtifact:vi.fn(artifactDownloadApi(Buffer.alloc(16385)))}}};await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:100,expired:false})).rejects.toThrow();
});
it('follows only the authenticated API signed storage redirect without forwarding credentials',async()=>{
 const bytes=receiptZip({schemaVersion:1});const storage='https://productionresultssa6.blob.core.windows.net/actions-results/fixed';
 const fetcher=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:storage}})).mockResolvedValueOnce(new Response(bytes,{headers:{'content-length':String(bytes.length)}}));vi.stubGlobal('fetch',fetcher);
 const github={rest:{actions:{downloadArtifact:vi.fn(async(args:any)=>({data:await args.request.fetch('https://api.github.com/repos/HamedMP/matrix-os/actions/artifacts/10/zip',{headers:{authorization:'unit-test'}})}))}}};
 try{await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:bytes.length,expired:false})).resolves.toEqual({schemaVersion:1});expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'manual',headers:{authorization:'unit-test'}});expect(fetcher.mock.calls[1][1].headers).toBeUndefined();expect(fetcher.mock.calls[1][1].redirect).toBe('error');}finally{vi.unstubAllGlobals();}
});
it.each(['http://127.0.0.1/a','https://evil.example/a','https://other.blob.core.windows.net/a','https://user:pass@productionresultssa6.blob.core.windows.net/a'])('rejects unsupported authenticated redirect %s',async location=>{
 const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{location}}));vi.stubGlobal('fetch',fetcher);
 const github={rest:{actions:{downloadArtifact:vi.fn(async(args:any)=>({data:await args.request.fetch('https://api.github.com/repos/HamedMP/matrix-os/actions/artifacts/10/zip',{})}))}}};
 try{await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:100,expired:false})).rejects.toThrow();expect(fetcher).toHaveBeenCalledOnce();}finally{vi.unstubAllGlobals();}
});
it('requires the API artifact digest when supplied and rejects unsupported unbounded client bodies',async()=>{
 const bytes=receiptZip({schemaVersion:1});let github={rest:{actions:{downloadArtifact:vi.fn(artifactDownloadApi(bytes))}}};
 await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:100,expired:false,digest:'sha256:'+'0'.repeat(64)})).rejects.toThrow(/digest/);
 github={rest:{actions:{downloadArtifact:vi.fn(async()=>({data:bytes}))}}} as any;
 await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:100,expired:false})).rejects.toThrow();
});

it.each([false,true])('reads bounded compressed JSON with streaming descriptor %s',descriptor=>{const value={schemaVersion:1,proof:'a'.repeat(500)};expect(decodeReceiptArchive(receiptZip(value,'receipt.json',{deflate:true,descriptor}))).toEqual(value);});
it('rejects compressed JSON whose expanded content exceeds the bound',()=>{expect(()=>decodeReceiptArchive(receiptZip({proof:'a'.repeat(20000)},'receipt.json',{deflate:true,descriptor:true}))).toThrow();});

it.each([
 [new SyntaxError('private receipt token'), 'invalid-input'],
 [new Error('private operator path'), 'unexpected-error'],
 [{message:'private receipt token'}, 'unexpected-error'],
])('records only a safe category when receipt JSON parsing fails', (error, errorKind)=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
 const parse=vi.spyOn(JSON,'parse').mockImplementationOnce(()=>{throw error;});
 try{
  expect(()=>decodeReceiptArchive(receiptZip({schemaVersion:1}))).toThrow('Controller receipt JSON rejected');
  expect(warn).toHaveBeenCalledExactlyOnceWith('Controller artifact rejected',{stage:'json',errorKind});
  expect(JSON.stringify(warn.mock.calls)).not.toContain('private');
 }finally{parse.mockRestore();warn.mockRestore();}
});
it('records a safe category for invalid compressed receipt bytes',()=>{
 const zip=receiptZip({schemaVersion:1},'receipt.json',{deflate:true});
 zip[42]=0xff;
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
 try{
  expect(()=>decodeReceiptArchive(zip)).toThrow('Bounded controller receipt expansion rejected');
  expect(warn).toHaveBeenCalledExactlyOnceWith('Controller artifact rejected',{stage:'expansion',errorKind:'invalid-input'});
 }finally{warn.mockRestore();}
});
it('does not log a malformed signed URL or its credentials',async()=>{
 const warn=vi.spyOn(console,'warn').mockImplementation(()=>undefined);
 const fetcher=vi.fn(async()=>new Response(null,{status:302,headers:{location:'private-invalid-url?token=secret'}}));vi.stubGlobal('fetch',fetcher);
 const github={rest:{actions:{downloadArtifact:vi.fn(async(args:any)=>({data:await args.request.fetch('https://api.github.com/repos/HamedMP/matrix-os/actions/artifacts/10/zip',{})}))}}};
 try{
  await expect(downloadControllerReceipt(github,repo,{id:10,size_in_bytes:100,expired:false})).rejects.toThrow('Controller artifact redirect rejected');
  expect(warn).toHaveBeenCalledExactlyOnceWith('Controller artifact rejected',{stage:'redirect',errorKind:'invalid-input'});
  expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret|token/);
  expect(fetcher).toHaveBeenCalledOnce();
 }finally{vi.unstubAllGlobals();warn.mockRestore();}
});
