import {describe,it,expect} from 'vitest';import {installedStoreManifest} from '../../../packages/gateway/src/app-store/install-manifest.js';import {AppManifestSchema} from '../../../packages/gateway/src/app-runtime/manifest-schema.js';import {assertRuntimeCompatible} from '../../../packages/gateway/src/app-runtime/runtime-version.js';
const manifest={name:'Sample',version:'1.0.0',runtime:'vite',permissions:[]};
describe('installed community manifest',()=>{
 it('adds a supported runtime version when the reviewed source omits it',()=>{const installed=installedStoreManifest(manifest as never,'sample');expect(AppManifestSchema.safeParse(installed).success).toBe(true);expect(()=>assertRuntimeCompatible(installed)).not.toThrow();expect(installed.runtimeVersion).toBe('^1.0.0');expect(installed.build?.output).toBe('dist');});
 it('preserves supported reviewed version ranges and rejects incompatible reviewed runtimes',()=>{expect(installedStoreManifest({...manifest,runtimeVersion:'~1.0.0'} as never,'sample').runtimeVersion).toBe('~1.0.0');expect(()=>installedStoreManifest({...manifest,runtimeVersion:'^9.0.0'} as never,'sample')).toThrow();});
 it('rejects a manifest which would not be discoverable before any publication',()=>{expect(()=>installedStoreManifest({...manifest,name:''} as never,'sample')).toThrow();});
});
