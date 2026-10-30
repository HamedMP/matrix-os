export interface RoutineCompilerInput { path: string; realPath: string; sha256: string }
export function collectRoutineCompilerInputs(root: string): Promise<RoutineCompilerInput[]>;
