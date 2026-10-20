import type {Transaction} from 'kysely';
import type {WorkspaceDatabase} from '../data/repository.js';
import type {RuntimeJob,RuntimeLease} from './contracts.js';

/** All hooks share the runtime transition transaction, with the owner row locked first. */
export interface RuntimeComputeHooks {
  claim(trx:Transaction<WorkspaceDatabase>,job:RuntimeJob,now:number,maxRunMs:number,generation:number):Promise<boolean>;
  allowed(trx:Transaction<WorkspaceDatabase>,ownerId:string):Promise<boolean>;
  needsInterruption?(trx:Transaction<WorkspaceDatabase>,ownerId:string,generation:number):Promise<boolean>;
  completion(trx:Transaction<WorkspaceDatabase>,lease:RuntimeLease,now:number):Promise<void>;
  uncertain(trx:Transaction<WorkspaceDatabase>,ownerId:string,generation:number):Promise<void>;
  confirmStopped(trx:Transaction<WorkspaceDatabase>,ownerId:string,currentGeneration:number,now:number):Promise<void>;
}
