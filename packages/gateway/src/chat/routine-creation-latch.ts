import type { CanonicalProviderRunInput } from './provider-adapter.js';
export interface RoutineCreationLatch {
  readonly attestedMatrix: boolean;
  current(): 'native' | 'matrix' | undefined;
  claim(engine: 'native' | 'matrix'): boolean;
}
/** One actual native phase owns this latch. Never stored in Chat settings, reused on a due phase,
 * reset on denial/cancel, or released after an unknown result. Claims are synchronous before effect. */
export function createRoutineCreationLatch(input: Pick<CanonicalProviderRunInput,'context'|'nativeScheduled'>): RoutineCreationLatch {
  const attestedMatrix=!input.nativeScheduled && input.context?.routineCreation==='matrix';
  let selected:'native'|'matrix'|undefined=input.nativeScheduled ? 'native' : attestedMatrix ? 'matrix' : undefined;
  return {attestedMatrix,current:()=>selected,claim(engine){if(selected && selected!==engine)return false;selected=engine;return true;}};
}
