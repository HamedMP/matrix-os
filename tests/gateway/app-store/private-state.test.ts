import {describe,it,expect,vi} from 'vitest';
vi.mock('node:fs/promises',()=>({rename:vi.fn(),unlink:vi.fn(),rm:vi.fn(),lstat:vi.fn()}));
import {unlink,rename} from 'node:fs/promises';
import {atomicPrivateFile} from '../../../packages/gateway/src/app-store/private-state.js';
describe('private atomic file cleanup',()=>{
 it.each(['write','sync'])('unlinks private temp when %s fails',async failure=>{
  vi.mocked(unlink).mockReset();vi.mocked(rename).mockReset();const error=new Error('injected IO failure');const close=vi.fn();
  const handle={writeFile:failure==='write'?vi.fn().mockRejectedValue(error):vi.fn(),sync:failure==='sync'?vi.fn().mockRejectedValue(error):vi.fn(),close};
  await expect(atomicPrivateFile({path:'/private',openFile:vi.fn().mockResolvedValue(handle)} as never,'state.json',Buffer.from('{}'))).rejects.toBe(error);
  expect(close).toHaveBeenCalledOnce();expect(unlink).toHaveBeenCalledOnce();expect(rename).not.toHaveBeenCalled();
 });
});
