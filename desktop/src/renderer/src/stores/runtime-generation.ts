let runtimeGeneration = 0;

export function captureRuntimeGeneration(): number {
  return runtimeGeneration;
}

export function isCurrentRuntimeGeneration(generation: number): boolean {
  return generation === runtimeGeneration;
}

export function advanceRuntimeGeneration(): number {
  runtimeGeneration += 1;
  return runtimeGeneration;
}
