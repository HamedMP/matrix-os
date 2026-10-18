// Fail-closed seam while the tests-first execution-origin contract is qualified.
export function executionBranch(){throw new Error('Isolated execution origin is not configured');}
export function executionControllerSha(){return null;}
export async function verifyIsolatedExecutionOrigin(){throw new Error('Isolated execution origin is not configured');}
export async function verifyIsolatedExecutionRun(){throw new Error('Isolated execution origin is not configured');}
