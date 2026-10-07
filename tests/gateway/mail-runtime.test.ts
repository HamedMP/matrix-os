import {describe,it,expect} from 'vitest';
import {mailRuntimeOwner,hasInstalledMailConsumer} from '../../packages/gateway/src/mail/runtime.js';
describe('mail production authority',()=>{
 it('maps only configured identities onto one owning computer',()=>{expect(mailRuntimeOwner('stranger',['owner','clerk'],'owner')).toBeNull();expect(mailRuntimeOwner('clerk',['owner','clerk'],'owner')).toBe('owner');expect(mailRuntimeOwner('owner',[],'owner')).toBeNull();});
 it('rejects unsupported copied identities before accessing the filesystem',async()=>{expect(await hasInstalledMailConsumer('/missing','my-edition')).toBe(false);expect(await hasInstalledMailConsumer('/missing','../edition')).toBe(false);});
});
