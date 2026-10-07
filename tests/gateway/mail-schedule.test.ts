import {describe,it,expect} from 'vitest';
import {MailSyncSchedule} from '../../packages/gateway/src/mail/schedule.js';
describe('bounded fair mail sync scheduling',()=>{
 it('rotates accounts and backs off failures while respecting explicit sync',()=>{const s=new MailSyncSchedule();expect(s.pick(['a','b'],0)).toBe('a');s.failed('a',0);expect(s.pick(['a','b'],1000)).toBe('b');expect(s.pick(['a'],1000)).toBeNull();expect(s.pick(['a'],60000)).toBe('a');s.failed('a',60000);expect(s.pick(['a'],120000)).toBeNull();s.request('a');expect(s.pick(['a'],120000)).toBe('a');});
 it('caps and evicts queued/deferred accounts and drops revoked accounts',()=>{const s=new MailSyncSchedule();for(let i=0;i<200;i++){s.request(String(i));s.failed(String(i),0);}expect(s.sizes()).toEqual({queued:100,failures:100});expect(s.pick(['valid'],0)).toBe('valid');expect(s.pick([],0)).toBeNull();expect(s.sizes()).toEqual({queued:0,failures:0});});
 it('resets failure history after success',()=>{const s=new MailSyncSchedule();s.failed('a',0);s.succeeded('a');expect(s.pick(['a'],1)).toBe('a');});
});

it('retains backoff when the remaining batch excludes an already attempted account',()=>{const s=new MailSyncSchedule();s.failed('a',0);expect(s.pick(['b'],1,['a','b'])).toBe('b');expect(s.pick(['a'],1000,['a','b'])).toBeNull();});
