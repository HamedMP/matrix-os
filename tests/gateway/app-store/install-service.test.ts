import {describe,it,expect} from 'vitest';
import {validateStoreGrant} from '../../../packages/gateway/src/app-store/install-validation.js';
import {generateKeyPairSync} from 'node:crypto';import {signStoreApproval} from '../../../packages/contracts/src/app-store-signing.js';
import {encodeAppBundle,bundleDigest} from '../../../packages/contracts/src/app-store-bundle.js';
import {capabilitiesDigest,deriveAppStoreCapabilities} from '../../../packages/contracts/src/app-store.js';
const manifest={name:'Sample',description:'An example',version:'1.0.0',runtime:'vite' as const,permissions:[]};
async function fixture(){const files=new Map([['matrix.json',Buffer.from(JSON.stringify(manifest))],['package.json',Buffer.from('{}')],['pnpm-lock.yaml',Buffer.from('lock')],['index.html',Buffer.from('hi')]]);const source=encodeAppBundle('source',files);const keys=generateKeyPairSync('ed25519');const capabilities=deriveAppStoreCapabilities(manifest);const digest=await capabilitiesDigest(capabilities);const grant={versionId:'e53000b2-83ab-4c64-b8fc-ff176d733cb0',version:'1.0.0',source:{url:'https://objects.test/source',sha256:bundleDigest(source),size:source.length},manifest,capabilities,capabilitiesDigest:digest,approval:{keyId:'test',signature:''}};grant.approval=signStoreApproval(grant,{keyId:'test',privateKey:keys.privateKey.export({type:'pkcs8',format:'pem'}).toString()});return {grant,source,keys:[{keyId:'test',publicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()}]};}
describe('reviewed source identity',()=>{
 it('accepts exact source approval and consent',async()=>{const f=await fixture();expect((await validateStoreGrant(f.grant,f.source,f.keys,f.grant.capabilitiesDigest)).files.size).toBe(4);});
 it('refuses unknown signing keys, altered source and mismatched consent',async()=>{const f=await fixture();await expect(validateStoreGrant(f.grant,f.source,[] ,f.grant.capabilitiesDigest)).rejects.toThrow();await expect(validateStoreGrant(f.grant,Buffer.from('forged'),f.keys,f.grant.capabilitiesDigest)).rejects.toThrow();await expect(validateStoreGrant(f.grant,f.source,f.keys,'0'.repeat(64))).rejects.toThrow();});
});
