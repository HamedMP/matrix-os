import {describe,it,expect} from 'vitest';
import {publicationRecoveryAction} from '../../../packages/gateway/src/app-store/install-recovery.js';
describe('durable publication recovery decisions',()=>{
 it('accepts publication only when actual source and dist both match',()=>{expect(publicationRecoveryAction({currentMatchesNew:true,currentMatchesPrevious:false,hasDestination:true,hasBackup:true})).toBe('commit');});
 it('restores previous state when rename never published',()=>{expect(publicationRecoveryAction({currentMatchesNew:false,currentMatchesPrevious:false,hasDestination:false,hasBackup:true})).toBe('restore');});
 it('rolls back metadata before first publication',()=>{expect(publicationRecoveryAction({currentMatchesNew:false,currentMatchesPrevious:false,hasDestination:false,hasBackup:false})).toBe('rollback');});
 it('preserves any unrecognized owner edit',()=>{expect(publicationRecoveryAction({currentMatchesNew:false,currentMatchesPrevious:false,hasDestination:true,hasBackup:true})).toBe('conflict');});
 it('keeps unchanged previous app when no backup rename happened',()=>{expect(publicationRecoveryAction({currentMatchesNew:false,currentMatchesPrevious:true,hasDestination:true,hasBackup:false})).toBe('rollback');});
});
